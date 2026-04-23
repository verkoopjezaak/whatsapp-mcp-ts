import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { jidNormalizedUser } from "@whiskeysockets/baileys";

import fs from "node:fs";
import path from "node:path";

import {
  type Message as DbMessage,
  type Chat as DbChat,
  getMessages,
  getChats,
  getChat,
  getMessagesAround,
  searchDbForContacts,
  searchMessages,
  updateMessageContent,
  enqueueOutgoingMessage,
  getOutgoingMessageById,
} from "./database.ts";

import { sendWhatsAppMessage, AUDIO_DIR, IMAGE_DIR, type WhatsAppSocket } from "./whatsapp.ts";
import { transcribeAudio } from "./transcribe.ts";
import { describeImage } from "./describe.ts";
import { readChatPdf } from "./read-pdf.ts";
import { type P } from "pino";

function formatDbMessageForJson(msg: DbMessage) {
  return {
    id: msg.id,
    chat_jid: msg.chat_jid,
    chat_name: msg.chat_name ?? "Unknown Chat",
    sender_jid: msg.sender ?? null,
    sender_display: msg.sender
      ? msg.sender.split("@")[0]
      : msg.is_from_me
        ? "Me"
        : "Unknown",
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
    is_from_me: msg.is_from_me,
  };
}

function formatDbChatForJson(chat: DbChat) {
  return {
    jid: chat.jid,
    name: chat.name ?? chat.jid.split("@")[0] ?? "Unknown Chat",
    is_group: chat.jid.endsWith("@g.us"),
    last_message_time: chat.last_message_time?.toISOString() ?? null,
    last_message_preview: chat.last_message ?? null,
    last_sender_jid: chat.last_sender ?? null,
    last_sender_display: chat.last_sender
      ? chat.last_sender.split("@")[0]
      : chat.last_is_from_me
        ? "Me"
        : null,
    last_is_from_me: chat.last_is_from_me ?? null,
  };
}

export async function startMcpServer(
  sock: WhatsAppSocket | null,
  mcpLogger: P.Logger,
  waLogger: P.Logger,
): Promise<void> {
  mcpLogger.info("Initializing MCP server...");

  const server = new McpServer(
    {
      name: "whatsapp-baileys-ts",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // @ts-expect-error — zod schema inference triggers TS2589 "excessively deep"; runtime is correct
  server.tool(
    "search_contacts",
    {
      query: z
        .string()
        .min(1)
        .describe("Search term for contact name or phone number part of JID"),
    },
    async ({ query }) => {
      mcpLogger.info(
        `[MCP Tool] Executing search_contacts with query: "${query}"`,
      );
      try {
        const contacts = searchDbForContacts(query, 20);
        const formattedContacts = contacts.map((c) => ({
          jid: c.jid,
          name: c.name ?? c.jid.split("@")[0],
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedContacts, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_contacts failed: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error searching contacts: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list_messages",
    {
      chat_jid: z
        .string()
        .describe(
          "The JID of the chat (e.g., '123456@s.whatsapp.net' or 'group@g.us')",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max messages per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ chat_jid, limit, page }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_messages for chat ${chat_jid}, limit=${limit}, page=${page}`,
      );
      try {
        const messages = getMessages(chat_jid, limit, page);
        if (!messages.length && page === 0) {
          return {
            content: [
              { type: "text", text: `No messages found for chat ${chat_jid}.` },
            ],
          };
        } else if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more messages found on page ${page} for chat ${chat_jid}.`,
              },
            ],
          };
        }
        const formattedMessages = messages.map(formatDbMessageForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] list_messages failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error listing messages for ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  // @ts-expect-error — zod schema inference triggers TS2589 "excessively deep"; runtime is correct
  server.tool(
    "list_chats",
    {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max chats per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
      sort_by: z
        .enum(["last_active", "name"])
        .optional()
        .default("last_active")
        .describe("Sort order: 'last_active' (default) or 'name'"),
      query: z
        .string()
        .optional()
        .describe("Optional filter by chat name or JID"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({ limit, page, sort_by, query, include_last_message }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_chats: limit=${limit}, page=${page}, sort=${sort_by}, query=${query}, lastMsg=${include_last_message}`,
      );
      try {
        const chats = getChats(
          limit,
          page,
          sort_by,
          query ?? null,
          include_last_message,
        );
        if (!chats.length && page === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No chats found${query ? ` matching "${query}"` : ""}.`,
              },
            ],
          };
        } else if (!chats.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more chats found on page ${page}${
                  query ? ` matching "${query}"` : ""
                }.`,
              },
            ],
          };
        }
        const formattedChats = chats.map(formatDbChatForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedChats, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] list_chats failed: ${error.message}`);
        return {
          isError: true,
          content: [
            { type: "text", text: `Error listing chats: ${error.message}` },
          ],
        };
      }
    },
  );

  server.tool(
    "get_chat",
    {
      chat_jid: z.string().describe("The JID of the chat to retrieve"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({ chat_jid, include_last_message }) => {
      mcpLogger.info(
        `[MCP Tool] Executing get_chat for ${chat_jid}, lastMsg=${include_last_message}`,
      );
      try {
        const chat = getChat(chat_jid, include_last_message);
        if (!chat) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Chat with JID ${chat_jid} not found.` },
            ],
          };
        }
        const formattedChat = formatDbChatForJson(chat);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedChat, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_chat failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "get_message_context",
    {
      message_id: z
        .string()
        .describe("The ID of the target message to get context around"),
      before: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages before (default 5)"),
      after: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages after (default 5)"),
    },
    async ({ message_id, before, after }) => {
      mcpLogger.info(
        `[MCP Tool] Executing get_message_context for msg ${message_id}, before=${before}, after=${after}`,
      );
      try {
        const context = getMessagesAround(message_id, before, after);
        if (!context.target) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Message with ID ${message_id} not found.`,
              },
            ],
          };
        }
        const formattedContext = {
          target: formatDbMessageForJson(context.target),
          before: context.before.map(formatDbMessageForJson),
          after: context.after.map(formatDbMessageForJson),
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedContext, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_message_context failed for ${message_id}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving context for message ${message_id}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "send_message",
    {
      recipient: z
        .string()
        .describe(
          "Recipient JID (user or group, e.g., '12345@s.whatsapp.net' or 'group123@g.us')",
        ),
      message: z.string().min(1).describe("The text message to send"),
      wait_for_delivery: z
        .boolean()
        .optional()
        .describe(
          "If true, poll the queue up to ~20s and return the final status (sent/failed/pending). Default: true in queue mode so agents get a reliable confirmation.",
        ),
    },
    async ({ recipient, message, wait_for_delivery }) => {
      mcpLogger.info(`[MCP Tool] Executing send_message to ${recipient}`);

      let normalizedRecipient: string;
      try {
        normalizedRecipient = jidNormalizedUser(recipient);
        if (!normalizedRecipient.includes("@")) {
          throw new Error('JID must contain "@" symbol');
        }
      } catch (normError: any) {
        mcpLogger.error(
          `[MCP Tool Error] Invalid recipient JID format: ${recipient}. Error: ${normError.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Invalid recipient format: "${recipient}". Please provide a valid JID (e.g., number@s.whatsapp.net or group@g.us).`,
            },
          ],
        };
      }

      // USE_QUEUE=1: persist in outgoing_messages queue zodat de daemon het
      // asynchroon verstuurt. Nodig voor split architectuur waarbij MCP-server
      // geen directe socket heeft. Default: wacht op aflevering zodat de
      // caller een betrouwbare bevestiging krijgt.
      if (process.env.USE_QUEUE === "1") {
        let queueId: number;
        try {
          queueId = enqueueOutgoingMessage({
            recipient_jid: normalizedRecipient,
            content: message,
            queued_by: "mcp-server",
          });
          mcpLogger.info(
            `[MCP Tool] send_message queued (id=${queueId}) for ${normalizedRecipient}`,
          );
        } catch (error: any) {
          mcpLogger.error(
            `[MCP Tool Error] send_message queue write failed: ${error.message}`,
          );
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error queuing message: ${error.message}`,
              },
            ],
          };
        }

        const shouldWait = wait_for_delivery !== false; // default true
        if (!shouldWait) {
          return {
            content: [
              {
                type: "text",
                text: `Message queued for delivery to ${normalizedRecipient} (queue id: ${queueId}). Daemon will deliver asynchronously.`,
              },
            ],
          };
        }

        // Poll the queue for a final status. Max ~20s wachten: Baileys kan
        // meerdere retries met backoff doen, dus we geven de processor tijd.
        const pollStart = Date.now();
        const POLL_TIMEOUT_MS = 20_000;
        const POLL_INTERVAL_MS = 500;
        let finalRow = getOutgoingMessageById(queueId);
        while (
          finalRow &&
          (finalRow.status === "pending" || finalRow.status === "sending") &&
          Date.now() - pollStart < POLL_TIMEOUT_MS
        ) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          finalRow = getOutgoingMessageById(queueId);
        }

        if (!finalRow) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Message enqueued (id=${queueId}) but queue row disappeared. Investigate database.`,
              },
            ],
          };
        }

        if (finalRow.status === "sent") {
          return {
            content: [
              {
                type: "text",
                text: `Message delivered to ${normalizedRecipient} (queue id: ${queueId}, wa id: ${finalRow.whatsapp_message_id ?? "unknown"}).`,
              },
            ],
          };
        }
        if (finalRow.status === "failed") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Message FAILED to deliver to ${normalizedRecipient} (queue id: ${queueId}). Reason: ${finalRow.error_message ?? "unknown"}. Check WhatsApp connection or verify recipient JID. Use get_send_status to re-check.`,
              },
            ],
          };
        }
        // Still pending/sending after timeout: socket likely down.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Message still pending after ${POLL_TIMEOUT_MS / 1000}s (queue id: ${queueId}, status: ${finalRow.status}). Daemon may be disconnected. The processor will retry automatically when the connection is restored. Use get_send_status to verify later.`,
            },
          ],
        };
      }

      if (!sock) {
        mcpLogger.error(
          "[MCP Tool Error] send_message failed: WhatsApp socket is not available.",
        );
        return {
          isError: true,
          content: [
            { type: "text", text: "Error: WhatsApp connection is not active." },
          ],
        };
      }

      try {
        const result = await sendWhatsAppMessage(
          waLogger,
          sock,
          normalizedRecipient,
          message,
        );

        if (result && result.key && result.key.id) {
          return {
            content: [
              {
                type: "text",
                text: `Message sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`,
              },
            ],
          };
        } else {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to send message to ${normalizedRecipient}. See server logs for details.`,
              },
            ],
          };
        }
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] send_message failed for ${recipient}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            { type: "text", text: `Error sending message: ${error.message}` },
          ],
        };
      }
    },
  );

  server.tool(
    "search_messages",
    {
      query: z
        .string()
        .min(1)
        .describe("The text content to search for within messages"),
      chat_jid: z
        .string()
        .optional()
        .describe(
          "Optional: The JID of a specific chat to search within (e.g., '123...net' or 'group@g.us'). If omitted, searches all chats.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe("Max messages per page (default 10)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ chat_jid, query, limit, page }) => {
      const searchScope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
      mcpLogger.info(
        `[MCP Tool] Executing search_messages ${searchScope}, query="${query}", limit=${limit}, page=${page}`,
      );
      try {
        const messages = searchMessages(query, chat_jid, limit, page);

        if (!messages.length && page === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No messages found containing "${query}" in chat ${chat_jid}.`,
              },
            ],
          };
        } else if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more messages found containing "${query}" on page ${page} for chat ${chat_jid}.`,
              },
            ],
          };
        }

        const formattedMessages = messages.map(formatDbMessageForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_messages_in_chat failed for ${chat_jid} / "${query}": ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error searching messages in chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "transcribe_chat",
    {
      chat_jid: z
        .string()
        .describe(
          "The JID of the chat to transcribe audio messages for (e.g., '31621516764@s.whatsapp.net')",
        ),
    },
    async ({ chat_jid }) => {
      mcpLogger.info(
        `[MCP Tool] Executing transcribe_chat for ${chat_jid}`,
      );
      try {
        // Get all untranscribed audio messages for this chat
        const allMessages = getMessages(chat_jid, 10000, 0);
        const audioMessages = allMessages.filter(
          (m) => m.content === "[Audio]",
        );

        if (audioMessages.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No untranscribed audio messages found in chat ${chat_jid}.`,
              },
            ],
          };
        }

        let transcribed = 0;
        let failed = 0;
        const results: string[] = [];

        for (const msg of audioMessages) {
          const audioPath = path.join(AUDIO_DIR, `${msg.id}.ogg`);
          if (!fs.existsSync(audioPath)) {
            failed++;
            results.push(`${msg.id}: no audio file on disk`);
            continue;
          }

          try {
            const buffer = fs.readFileSync(audioPath);
            const transcription = await transcribeAudio(buffer, mcpLogger);

            if (transcription) {
              updateMessageContent(
                msg.id,
                msg.chat_jid,
                `[Audio] ${transcription}`,
              );
              transcribed++;
              results.push(
                `${msg.id}: "${transcription.substring(0, 60)}..."`,
              );
            } else {
              failed++;
              results.push(`${msg.id}: transcription returned empty`);
            }
          } catch (err: any) {
            failed++;
            results.push(`${msg.id}: ${err.message}`);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  chat_jid,
                  total_audio: audioMessages.length,
                  transcribed,
                  failed,
                  details: results,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] transcribe_chat failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error transcribing chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  // @ts-expect-error — zod schema inference triggers TS2589 "excessively deep"; runtime is correct
  server.tool(
    "describe_chat_images",
    {
      chat_jid: z
        .string()
        .describe(
          "The JID of the chat to describe image messages for (e.g., '120363424734382777@g.us')",
        ),
      message_id: z
        .string()
        .optional()
        .describe(
          "Optional specific message_id to describe. If omitted, all undescribed images in the chat are processed.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Max number of images to describe in one call (default 20, kostenbeheersing)",
        ),
    },
    async ({ chat_jid, message_id, limit }) => {
      mcpLogger.info(
        `[MCP Tool] Executing describe_chat_images for ${chat_jid}${message_id ? ` msg=${message_id}` : ""}`,
      );
      try {
        const allMessages = getMessages(chat_jid, 10000, 0);
        let imageMessages = allMessages.filter(
          (m) => m.content === "[Image]" || m.content.startsWith("[Image] "),
        );

        // Only re-describe when there's no existing description body
        // "[Image]" (no caption, no description) or "[Image] <caption>" (caption only)
        // Once described we write "[Image: <description>]" which is excluded below.
        imageMessages = imageMessages.filter(
          (m) => !m.content.startsWith("[Image:"),
        );

        if (message_id) {
          imageMessages = imageMessages.filter((m) => m.id === message_id);
        }

        const cap = limit ?? 20;
        imageMessages = imageMessages.slice(0, cap);

        if (imageMessages.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No undescribed images found in chat ${chat_jid}${message_id ? ` for message ${message_id}` : ""}.`,
              },
            ],
          };
        }

        let described = 0;
        let failed = 0;
        const results: Array<{
          id: string;
          status: string;
          description?: string;
        }> = [];

        for (const msg of imageMessages) {
          const imagePath = path.join(IMAGE_DIR, `${msg.id}.jpg`);
          if (!fs.existsSync(imagePath)) {
            failed++;
            results.push({ id: msg.id, status: "no image file on disk" });
            continue;
          }

          try {
            const buffer = fs.readFileSync(imagePath);
            const caption =
              msg.content.startsWith("[Image] ") && msg.content.length > 8
                ? msg.content.substring(8)
                : null;
            const description = await describeImage(
              buffer,
              caption,
              mcpLogger,
            );

            if (description) {
              const newContent = caption
                ? `[Image: ${description}] caption: ${caption}`
                : `[Image: ${description}]`;
              updateMessageContent(msg.id, msg.chat_jid, newContent);
              described++;
              results.push({
                id: msg.id,
                status: "described",
                description: description.substring(0, 200),
              });
            } else {
              failed++;
              results.push({
                id: msg.id,
                status: "description returned empty",
              });
            }
          } catch (err: any) {
            failed++;
            results.push({ id: msg.id, status: `error: ${err.message}` });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  chat_jid,
                  total_images: imageMessages.length,
                  described,
                  failed,
                  details: results,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] describe_chat_images failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error describing images in chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "read_chat_pdfs",
    {
      chat_jid: z
        .string()
        .describe(
          "The JID of the chat to read PDF messages from (e.g., '31612345678@s.whatsapp.net')",
        ),
      message_id: z
        .string()
        .optional()
        .describe(
          "Optional specific message_id to read. If omitted, all undprocessed PDFs in the chat are read (up to limit).",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Max number of PDFs to read in one call (default 5, kostenbeheersing)",
        ),
    },
    async ({ chat_jid, message_id, limit }) => {
      mcpLogger.info(
        `[MCP Tool] Executing read_chat_pdfs for ${chat_jid}${message_id ? ` msg=${message_id}` : ""}`,
      );
      try {
        const allMessages = getMessages(chat_jid, 10000, 0);
        let pdfMessages = allMessages.filter((m) =>
          m.content.startsWith("[PDF]"),
        );

        // Skip ones that already have extracted text in content
        pdfMessages = pdfMessages.filter(
          (m) => !m.content.includes("[PDF text:"),
        );

        if (message_id) {
          pdfMessages = pdfMessages.filter((m) => m.id === message_id);
        }

        const cap = limit ?? 5;
        pdfMessages = pdfMessages.slice(0, cap);

        if (pdfMessages.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    chat_jid,
                    total_pdfs: 0,
                    read: 0,
                    details: [],
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const results = [];
        let readOk = 0;
        let failed = 0;
        for (const m of pdfMessages) {
          const result = await readChatPdf(m.id, mcpLogger);
          if (result.status === "read") {
            readOk++;
            results.push({
              id: m.id,
              filename: m.content.replace(/^\[PDF\]\s*/, "").split(" — ")[0],
              pages: result.pages,
              truncated: result.truncated,
              text: result.text,
            });
          } else {
            failed++;
            results.push({
              id: m.id,
              status: result.status,
              error: result.error,
            });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  chat_jid,
                  total_pdfs: pdfMessages.length,
                  read: readOk,
                  failed,
                  details: results,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] read_chat_pdfs failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error reading PDFs in chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "get_send_status",
    {
      queue_id: z
        .number()
        .int()
        .positive()
        .describe(
          "The queue id returned by send_message. Use this to verify whether a message was actually delivered.",
        ),
    },
    async ({ queue_id }) => {
      mcpLogger.info(`[MCP Tool] Executing get_send_status for id=${queue_id}`);
      try {
        const row = getOutgoingMessageById(queue_id);
        if (!row) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `No outgoing message found with queue id ${queue_id}.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  queue_id: row.id,
                  recipient: row.recipient_jid,
                  status: row.status,
                  attempts: row.attempts ?? 0,
                  queued_at: row.queued_at,
                  sent_at: row.sent_at,
                  whatsapp_message_id: row.whatsapp_message_id ?? null,
                  error_message: row.error_message ?? null,
                  delivered: row.status === "sent",
                  content_preview:
                    row.content.length > 80
                      ? row.content.substring(0, 80) + "..."
                      : row.content,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_send_status failed for id=${queue_id}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error reading send status: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.resource("db_schema", "schema://whatsapp/main", async (uri) => {
    mcpLogger.info(`[MCP Resource] Request for ${uri.href}`);
    const schemaText = `
TABLE chats (jid TEXT PK, name TEXT, last_message_time TIMESTAMP)
TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, PK(id, chat_jid), FK(chat_jid) REFERENCES chats(jid))
            `.trim();
    return {
      contents: [
        {
          uri: uri.href,
          text: schemaText,
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  mcpLogger.info("MCP server configured. Connecting stdio transport...");

  try {
    await server.connect(transport);
    mcpLogger.info(
      "MCP transport connected. Server is ready and listening via stdio.",
    );
  } catch (error: any) {
    mcpLogger.error(
      `[FATAL] Failed to connect MCP transport: ${error.message}`,
      error,
    );
    process.exit(1);
  }

  mcpLogger.info(
    "MCP Server setup complete. Waiting for requests from client...",
  );
}
