import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  DisconnectReason,
  type WAMessage,
  type proto,
  isJidGroup,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import P from "pino";
import path from "node:path";
import fs from "node:fs";
// @ts-ignore — qrcode-terminal heeft geen types
import qrcode from "qrcode-terminal";

import {
  initializeDatabase,
  storeMessage,
  storeChat,
  storeContact,
  updateMessageContent,
  type Message as DbMessage,
} from "./database.ts";
import { transcribeAudio } from "./transcribe.ts";

const AUTH_DIR = path.join(import.meta.dirname, "..", "auth_info");

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

function parseMessageForDb(msg: WAMessage): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }

  let content: string | null = null;
  const messageType = Object.keys(msg.message)[0];

  if (msg.message.conversation) {
    content = msg.message.conversation;
  } else if (msg.message.extendedTextMessage?.text) {
    content = msg.message.extendedTextMessage.text;
  } else if (msg.message.imageMessage) {
    const cap = msg.message.imageMessage.caption;
    content = cap ? `[Image] ${cap}` : `[Image]`;
  } else if (msg.message.videoMessage?.caption) {
    content = `[Video] ${msg.message.videoMessage.caption}`;
  } else if (msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage) {
    const doc =
      msg.message.documentMessage ||
      msg.message.documentWithCaptionMessage?.message?.documentMessage!;
    const fileName = doc.fileName || "document";
    const caption = doc.caption || msg.message.documentWithCaptionMessage?.message?.documentMessage?.caption;
    const prefix = doc.mimetype === "application/pdf" ? "[PDF]" : "[Document]";
    content = caption ? `${prefix} ${fileName} — ${caption}` : `${prefix} ${fileName}`;
  } else if (msg.message.audioMessage) {
    content = `[Audio]`;
  } else if (msg.message.stickerMessage) {
    content = `[Sticker]`;
  } else if (msg.message.locationMessage?.address) {
    content = `[Location] ${msg.message.locationMessage.address}`;
  } else if (msg.message.contactMessage?.displayName) {
    content = `[Contact] ${msg.message.contactMessage.displayName}`;
  } else if (msg.message.pollCreationMessage?.name) {
    content = `[Poll] ${msg.message.pollCreationMessage.name}`;
  }

  if (!content) {
    return null;
  }

  // Use WhatsApp's original message timestamp (seconds since epoch)
  let timestampSeconds: number;

  if (msg.messageTimestamp != null) {
    // Handles number, bigint, and Long-like objects
    timestampSeconds = Number(msg.messageTimestamp);
  } else {
    // Fallback only if WA didn't give us a timestamp at all
    timestampSeconds = Date.now() / 1000;
  }

  const timestamp = new Date(timestampSeconds * 1000);

  let senderJid: string | null | undefined = msg.key.participant;
  if (!msg.key.fromMe && !senderJid && !isJidGroup(msg.key.remoteJid)) {
    senderJid = msg.key.remoteJid;
  }
  if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) {
    senderJid = null;
  }

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderJid ? jidNormalizedUser(senderJid) : null,
    content: content,
    timestamp: timestamp,
    is_from_me: msg.key.fromMe ?? false,
  };
}

// --- Audio save & transcription ---

export const AUDIO_DIR = path.join(
  process.env.WHATSAPP_MCP_DATA_DIR || import.meta.dirname,
  "data",
  "audio",
);

export const IMAGE_DIR = path.join(
  process.env.WHATSAPP_MCP_DATA_DIR || import.meta.dirname,
  "data",
  "images",
);

export const DOCUMENT_DIR = path.join(
  process.env.WHATSAPP_MCP_DATA_DIR || import.meta.dirname,
  "data",
  "documents",
);

// Ensure audio directory exists
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// Ensure image directory exists
if (!fs.existsSync(IMAGE_DIR)) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

// Ensure document directory exists
if (!fs.existsSync(DOCUMENT_DIR)) {
  fs.mkdirSync(DOCUMENT_DIR, { recursive: true });
}

async function saveImageToDisk(
  msg: WAMessage,
  messageId: string,
  sock: WhatsAppSocket,
  logger: P.Logger,
): Promise<boolean> {
  const imagePath = path.join(IMAGE_DIR, `${messageId}.jpg`);
  if (fs.existsSync(imagePath)) return true;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        (attempt === 0
          ? { reuploadRequest: sock.updateMediaMessage, logger }
          : { logger }) as any,
      );

      if (!buffer || (buffer as Buffer).length === 0) {
        logger.warn(`Empty image buffer for message ${messageId}`);
        return false;
      }

      fs.writeFileSync(imagePath, buffer as Buffer);
      logger.info(
        `Saved image ${messageId} (${(buffer as Buffer).length} bytes)`,
      );
      return true;
    } catch (error: any) {
      if (attempt === 0) continue;
      logger.warn(`Failed to download image ${messageId}: ${error.message}`);
      return false;
    }
  }
  return false;
}

async function saveDocumentToDisk(
  msg: WAMessage,
  messageId: string,
  sock: WhatsAppSocket,
  logger: P.Logger,
): Promise<{ path: string; mimetype: string | null; fileName: string | null } | null> {
  const doc =
    msg.message?.documentMessage ||
    msg.message?.documentWithCaptionMessage?.message?.documentMessage;
  if (!doc) return null;

  const ext = doc.mimetype === "application/pdf" ? "pdf" : "bin";
  const docPath = path.join(DOCUMENT_DIR, `${messageId}.${ext}`);
  if (fs.existsSync(docPath)) {
    return { path: docPath, mimetype: doc.mimetype ?? null, fileName: doc.fileName ?? null };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        (attempt === 0
          ? { reuploadRequest: sock.updateMediaMessage, logger }
          : { logger }) as any,
      );

      if (!buffer || (buffer as Buffer).length === 0) {
        logger.warn(`Empty document buffer for message ${messageId}`);
        return null;
      }

      fs.writeFileSync(docPath, buffer as Buffer);
      logger.info(
        `Saved document ${messageId} (${(buffer as Buffer).length} bytes, ${doc.mimetype || "unknown"})`,
      );
      return { path: docPath, mimetype: doc.mimetype ?? null, fileName: doc.fileName ?? null };
    } catch (error: any) {
      if (attempt === 0) continue;
      logger.warn(`Failed to download document ${messageId}: ${error.message}`);
      return null;
    }
  }
  return null;
}

async function saveAudioToDisk(
  msg: WAMessage,
  messageId: string,
  sock: WhatsAppSocket,
  logger: P.Logger,
): Promise<boolean> {
  const audioPath = path.join(AUDIO_DIR, `${messageId}.ogg`);
  if (fs.existsSync(audioPath)) return true;

  // Try download, then retry once without reuploadRequest on failure
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        (attempt === 0
          ? { reuploadRequest: sock.updateMediaMessage, logger }
          : { logger }) as any,
      );

      if (!buffer || (buffer as Buffer).length === 0) {
        logger.warn(`Empty audio buffer for message ${messageId}`);
        return false;
      }

      fs.writeFileSync(audioPath, buffer as Buffer);
      logger.info(
        `Saved audio ${messageId} (${(buffer as Buffer).length} bytes)`,
      );
      return true;
    } catch (error: any) {
      if (attempt === 0) continue;
      logger.warn(`Failed to download audio ${messageId}: ${error.message}`);
      return false;
    }
  }
  return false;
}

async function downloadAndTranscribe(
  msg: WAMessage,
  messageId: string,
  chatJid: string,
  sock: WhatsAppSocket,
  logger: P.Logger,
) {
  const saved = await saveAudioToDisk(msg, messageId, sock, logger);
  if (!saved) return;

  try {
    const audioPath = path.join(AUDIO_DIR, `${messageId}.ogg`);
    const buffer = fs.readFileSync(audioPath);
    const transcription = await transcribeAudio(buffer, logger);

    if (transcription) {
      updateMessageContent(messageId, chatJid, `[Audio] ${transcription}`);
      logger.info(
        `Transcribed ${messageId}: "${transcription.substring(0, 80)}..."`,
      );
    }
  } catch (error: any) {
    logger.error(`Failed to transcribe ${messageId}: ${error.message}`);
  }
}

// Sequential batch processor for audio downloads during history sync
const audioBatchQueue: { msg: WAMessage; id: string }[] = [];
let isBatchProcessing = false;

function saveAudioBatch(
  items: { msg: WAMessage; id: string }[],
  sock: WhatsAppSocket,
  logger: P.Logger,
) {
  audioBatchQueue.push(...items);
  if (!isBatchProcessing) {
    isBatchProcessing = true;
    processAudioBatch(sock, logger);
  }
}

async function processAudioBatch(sock: WhatsAppSocket, logger: P.Logger) {
  let saved = 0;
  let failed = 0;
  const total = audioBatchQueue.length;

  while (audioBatchQueue.length > 0) {
    const item = audioBatchQueue.shift()!;
    const ok = await saveAudioToDisk(item.msg, item.id, sock, logger);
    if (ok) saved++;
    else failed++;
  }

  logger.info(
    `Audio batch done: ${saved} saved, ${failed} failed out of ${total}`,
  );
  isBatchProcessing = false;
}

// Sequential batch processor for image downloads during history sync
const imageBatchQueue: { msg: WAMessage; id: string }[] = [];
let isImageBatchProcessing = false;

function saveImageBatch(
  items: { msg: WAMessage; id: string }[],
  sock: WhatsAppSocket,
  logger: P.Logger,
) {
  imageBatchQueue.push(...items);
  if (!isImageBatchProcessing) {
    isImageBatchProcessing = true;
    processImageBatch(sock, logger);
  }
}

async function processImageBatch(sock: WhatsAppSocket, logger: P.Logger) {
  let saved = 0;
  let failed = 0;
  const total = imageBatchQueue.length;

  while (imageBatchQueue.length > 0) {
    const item = imageBatchQueue.shift()!;
    const ok = await saveImageToDisk(item.msg, item.id, sock, logger);
    if (ok) saved++;
    else failed++;
  }

  logger.info(
    `Image batch done: ${saved} saved, ${failed} failed out of ${total}`,
  );
  isImageBatchProcessing = false;
}

// --- End audio save & transcription ---

export async function startWhatsAppConnection(
  logger: P.Logger
): Promise<WhatsAppSocket> {
  initializeDatabase();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    syncFullHistory: true,
    // Include group chats so client group messages are also captured
    shouldIgnoreJid: () => false,
  });

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info("QR Code received. Scan with WhatsApp > Linked Devices.");
        const qrFilePath = path.join(process.env.WHATSAPP_MCP_DATA_DIR || ".", "qr-code.txt");
        qrcode.generate(qr, { small: true }, (code: string) => {
          // Write QR to stderr so it doesn't interfere with MCP stdio
          process.stderr.write("\n=== Scan this QR code with WhatsApp ===\n");
          process.stderr.write(code);
          process.stderr.write("\n=======================================\n");
          // Also save to file for easy access
          fs.writeFileSync(qrFilePath, `=== Scan this QR code with WhatsApp ===\n${code}\n=======================================\n`);
          logger.info(`QR code saved to ${qrFilePath}`);
        });
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.warn(
          `Connection closed. Reason: ${
            DisconnectReason[statusCode as number] || "Unknown"
          }`,
          lastDisconnect?.error
        );
        if (statusCode === DisconnectReason.loggedOut) {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          process.exit(1);
        } else if (statusCode === DisconnectReason.connectionReplaced) {
          logger.error(
            "Connection replaced by another session. Exiting to avoid orphan MCP processes."
          );
          process.exit(1);
        } else {
          logger.info("Reconnecting...");
          startWhatsAppConnection(logger);
        }
      } else if (connection === "open") {
        logger.info(`Connection opened. WA user: ${sock.user?.name}`);
        // console.log("Logged as", sock.user?.name);
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      logger.info("Credentials saved.");
    }

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages, isLatest, progress, syncType } =
        events["messaging-history.set"];
      if (contacts.length > 0) {
        logger.info(`Storing ${contacts.length} contacts from history sync.`);
        contacts.forEach((c) =>
          storeContact({
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
            phoneNumber: (c as any).phoneNumber ?? null,
          })
        );
        logger.info(`Stored ${contacts.length} contacts from history sync.`);
      }

      logger.info(`Storing ${chats.length} chats from history sync.`);
      chats.forEach((chat) =>
        storeChat({
          jid: chat.id,
          name: chat.name,
          last_message_time: chat.conversationTimestamp
            ? new Date(Number(chat.conversationTimestamp) * 1000)
            : undefined,
        })
      );

      let storedCount = 0;
      const audioMessages: { msg: WAMessage; id: string }[] = [];
      const imageMessages: { msg: WAMessage; id: string }[] = [];
      messages.forEach((msg) => {
        const parsed = parseMessageForDb(msg);
        if (parsed) {
          storeMessage(parsed);
          storedCount++;
          if (parsed.content === "[Audio]" && msg.message?.audioMessage) {
            audioMessages.push({ msg, id: parsed.id });
          }
          if (
            parsed.content.startsWith("[Image]") &&
            msg.message?.imageMessage
          ) {
            imageMessages.push({ msg, id: parsed.id });
          }
        }
      });
      logger.info(`Stored ${storedCount} messages from history sync.`);

      // Save audio files to disk sequentially (no transcription, on-demand only)
      if (audioMessages.length > 0) {
        logger.info(
          `Saving ${audioMessages.length} audio files to disk from history sync`,
        );
        saveAudioBatch(audioMessages, sock, logger);
      }

      // Save image files to disk sequentially (no description, on-demand only)
      if (imageMessages.length > 0) {
        logger.info(
          `Saving ${imageMessages.length} image files to disk from history sync`,
        );
        saveImageBatch(imageMessages, sock, logger);
      }
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      logger.info(
        { type, count: messages.length },
        "Received messages.upsert event"
      );

      if (type === "notify" || type === "append") {
        for (const msg of messages) {
          const parsed = parseMessageForDb(msg);
          if (parsed) {
            logger.info(
              {
                msgId: parsed.id,
                chatId: parsed.chat_jid,
                fromMe: parsed.is_from_me,
                sender: parsed.sender,
              },
              `Storing message: ${parsed.content.substring(0, 50)}...`,
            );
            storeMessage(parsed);

            // Real-time audio: save to disk + transcribe immediately
            if (parsed.content === "[Audio]" && msg.message?.audioMessage) {
              downloadAndTranscribe(
                msg,
                parsed.id,
                parsed.chat_jid,
                sock,
                logger,
              ).catch((err) =>
                logger.error(`Audio processing failed: ${err.message}`),
              );
            }

            // Real-time image: save to disk only (describe on-demand via MCP tool)
            if (
              parsed.content.startsWith("[Image]") &&
              msg.message?.imageMessage
            ) {
              saveImageToDisk(msg, parsed.id, sock, logger).catch((err) =>
                logger.error(`Image save failed: ${err.message}`),
              );
            }

            // Real-time document: save to disk (read on-demand via MCP tool)
            if (
              (parsed.content.startsWith("[PDF]") ||
                parsed.content.startsWith("[Document]")) &&
              (msg.message?.documentMessage ||
                msg.message?.documentWithCaptionMessage)
            ) {
              saveDocumentToDisk(msg, parsed.id, sock, logger).catch((err) =>
                logger.error(`Document save failed: ${err.message}`),
              );
            }
          } else {
            logger.warn(
              { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Skipped storing message (parsing failed or unsupported type)",
            );
          }
        }
      }
    }

    if (events["chats.update"]) {
      logger.info(
        { count: events["chats.update"].length },
        "Received chats.update event"
      );
      for (const chatUpdate of events["chats.update"]) {
        storeChat({
          jid: chatUpdate.id!,
          name: chatUpdate.name,
          last_message_time: chatUpdate.conversationTimestamp
            ? new Date(Number(chatUpdate.conversationTimestamp) * 1000)
            : undefined,
        });
      }
    }
  });

  return sock;
}

export async function sendWhatsAppMessage(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  recipientJid: string,
  text: string
): Promise<proto.WebMessageInfo | void> {
  if (!sock || !sock.user) {
    logger.error(
      "Cannot send message: WhatsApp socket not connected or initialized."
    );
    return;
  }
  if (!recipientJid) {
    logger.error("Cannot send message: Recipient JID is missing.");
    return;
  }
  if (!text) {
    logger.error("Cannot send message: Message text is empty.");
    return;
  }

  try {
    logger.info(
      `Sending message to ${recipientJid}: ${text.substring(0, 50)}...`
    );
    const normalizedJid = jidNormalizedUser(recipientJid);
    const result = await sock.sendMessage(normalizedJid, { text: text });
    logger.info({ msgId: result?.key.id }, "Message sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid }, "Failed to send message");
    return;
  }
}
