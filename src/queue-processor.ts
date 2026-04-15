import type { Logger } from "pino";
import {
  claimPendingOutgoingMessages,
  markOutgoingSent,
  markOutgoingFailed,
} from "./database.ts";
import { sendWhatsAppMessage, type WhatsAppSocket } from "./whatsapp.ts";

const POLL_INTERVAL_MS = Number(process.env.QUEUE_POLL_MS ?? 2000);
const BATCH_SIZE = Number(process.env.QUEUE_BATCH_SIZE ?? 10);

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
        try {
          const result = await sendWhatsAppMessage(
            logger,
            sock,
            row.recipient_jid,
            row.content,
          );
          if (result && result.key && result.key.id) {
            markOutgoingSent(row.id);
            logger.info(
              `[queue-processor] sent id=${row.id} to=${row.recipient_jid} waId=${result.key.id}`,
            );
          } else {
            markOutgoingFailed(row.id, "sendMessage returned no key");
            logger.warn(
              `[queue-processor] failed id=${row.id} to=${row.recipient_jid} (no key returned)`,
            );
          }
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          markOutgoingFailed(row.id, msg);
          logger.error(
            { err },
            `[queue-processor] error id=${row.id} to=${row.recipient_jid}: ${msg}`,
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
