import type { Logger } from "pino";
import {
  claimPendingOutgoingMessages,
  markOutgoingSent,
  markOutgoingFailed,
} from "./database.ts";
import {
  sendWhatsAppMessage,
  WhatsAppSendError,
  type WhatsAppSocket,
} from "./whatsapp.ts";

const POLL_INTERVAL_MS = Number(process.env.QUEUE_POLL_MS ?? 2000);
const BATCH_SIZE = Number(process.env.QUEUE_BATCH_SIZE ?? 10);
const MAX_ATTEMPTS = Number(process.env.QUEUE_MAX_ATTEMPTS ?? 3);
const RETRY_BACKOFF_MS = Number(process.env.QUEUE_RETRY_BACKOFF_MS ?? 500);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Periodic processor for the outgoing_messages queue. Claims pending rows
 * atomically (pending -> sending), attempts delivery via the WhatsApp socket,
 * and marks each row sent or failed. Run inside the daemon that owns the
 * WhatsApp connection — never from the MCP server.
 */
export function startQueueProcessor(params: {
  sock: WhatsAppSocket;
  logger: Logger;
  getSocket?: () => WhatsAppSocket | null;
}): { stop: () => void } {
  const { logger } = params;
  const resolveSocket = params.getSocket ?? (() => params.sock);

  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped) return;
    if (running) return; // skip if previous tick still running
    running = true;

    try {
      const sock = resolveSocket();
      if (!sock) {
        // Socket not ready (still connecting); wait for next tick.
        return;
      }

      const batch = claimPendingOutgoingMessages(BATCH_SIZE);
      if (batch.length === 0) return;

      logger.info(
        `[queue-processor] Processing ${batch.length} outgoing messages`,
      );

      for (const row of batch) {
        let lastError: string | null = null;
        let sent = false;
        let permanent = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !sent; attempt++) {
          try {
            const result = await sendWhatsAppMessage(
              logger,
              sock,
              row.recipient_jid,
              row.content,
            );
            markOutgoingSent(row.id);
            logger.info(
              `[queue-processor] sent id=${row.id} to=${row.recipient_jid} attempt=${attempt} waId=${result.key.id}`,
            );
            sent = true;
          } catch (err: any) {
            const isPermanent = err instanceof WhatsAppSendError && err.isPermanent;
            // Bewaar volledige context: statusCode + message + Baileys data code.
            const parts = [err?.message ?? String(err)];
            if (err?.statusCode) parts.push(`status=${err.statusCode}`);
            if (err?.data != null && err.data !== err.statusCode) {
              parts.push(`data=${err.data}`);
            }
            lastError = parts.join(" | ");
            logger.warn(
              { err, permanent: isPermanent },
              `[queue-processor] attempt ${attempt}/${MAX_ATTEMPTS} error id=${row.id}: ${lastError}`,
            );
            if (isPermanent) {
              permanent = true;
              break; // retry lost niets op bij 406 / logged out
            }
          }

          if (!sent && attempt < MAX_ATTEMPTS) {
            await sleep(RETRY_BACKOFF_MS * attempt);
          }
        }

        if (!sent) {
          const finalError = permanent
            ? `PERMANENT: ${lastError}`
            : (lastError ?? `failed after ${MAX_ATTEMPTS} attempts`);
          markOutgoingFailed(row.id, finalError);
          logger.error(
            { permanent },
            `[queue-processor] ${permanent ? "permanent" : "retry-exhausted"} failure id=${row.id} to=${row.recipient_jid}: ${finalError}`,
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "[queue-processor] tick failure");
    } finally {
      running = false;
    }
  };

  const interval = setInterval(tick, POLL_INTERVAL_MS);
  logger.info(
    `[queue-processor] started (poll=${POLL_INTERVAL_MS}ms, batch=${BATCH_SIZE})`,
  );

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
      logger.info("[queue-processor] stopped");
    },
  };
}
