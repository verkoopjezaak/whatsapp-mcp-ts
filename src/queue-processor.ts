import type { Logger } from "pino";
import {
  claimPendingOutgoingMessages,
  markOutgoingSent,
  markOutgoingFailed,
  releaseOutgoingToPending,
  incrementOutgoingAttempt,
} from "./database.ts";
import { sendWhatsAppMessage, type WhatsAppSocket } from "./whatsapp.ts";

const POLL_INTERVAL_MS = Number(process.env.QUEUE_POLL_MS ?? 2000);
const BATCH_SIZE = Number(process.env.QUEUE_BATCH_SIZE ?? 10);
const MAX_ATTEMPTS = Number(process.env.QUEUE_MAX_ATTEMPTS ?? 5);
const RETRY_BACKOFF_MS = Number(process.env.QUEUE_RETRY_BACKOFF_MS ?? 1000);
const SOCKET_READY_WAIT_MS = Number(
  process.env.QUEUE_SOCKET_READY_WAIT_MS ?? 30000,
);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fouten waarvoor het zinloos is om de row binnen dezelfde tick nog eens te
 * proberen: socket is dicht. We zetten de row terug naar pending en wachten
 * tot de daemon opnieuw verbonden is (via de reconnect-logica in
 * startWhatsAppConnection). Zo verliezen we geen attempts aan een dode socket.
 */
function isTransientSocketError(err: any): boolean {
  const statusCode = err?.output?.statusCode ?? err?.data;
  const message = String(err?.message ?? err ?? "");
  if (statusCode === 428) return true; // Precondition Required = Connection Closed
  if (statusCode === 408) return true; // Request Time-out
  if (/Connection Closed/i.test(message)) return true;
  if (/Timed Out/i.test(message)) return true;
  if (/not connected/i.test(message)) return true;
  return false;
}

function isSocketReady(sock: WhatsAppSocket | null): boolean {
  if (!sock) return false;
  // Baileys sets sock.user when the connection is 'open' and authenticated.
  if (!sock.user) return false;
  // ws readyState 1 = OPEN
  const ws: any = (sock as any).ws;
  if (ws && typeof ws.readyState === "number" && ws.readyState !== 1) {
    return false;
  }
  return true;
}

async function waitForSocketReady(
  getSocket: () => WhatsAppSocket | null,
  logger: Logger,
  maxWaitMs: number,
): Promise<WhatsAppSocket | null> {
  const start = Date.now();
  let warned = false;
  while (Date.now() - start < maxWaitMs) {
    const sock = getSocket();
    if (isSocketReady(sock)) return sock;
    if (!warned) {
      logger.warn(
        `[queue-processor] socket not ready, waiting up to ${maxWaitMs}ms for reconnect...`,
      );
      warned = true;
    }
    await sleep(500);
  }
  return null;
}

/**
 * Periodic processor for the outgoing_messages queue. Claims pending rows
 * atomically (pending -> sending), attempts delivery via the WhatsApp socket,
 * and marks each row sent or failed. Run inside the daemon that owns the
 * WhatsApp connection, never from the MCP server.
 *
 * Retry-strategie:
 * - Transient socket-fouten (Connection Closed, Timed Out) worden NIET als
 *   attempt geteld. We zetten de row terug naar pending en wachten op
 *   reconnect. Dit voorkomt dat een korte WA-disconnect een complete row
 *   uitput zonder echt te proberen.
 * - Overige fouten (not-acceptable, permission, etc.) tellen als attempt.
 * - Na MAX_ATTEMPTS echte fouten wordt de row als failed gemarkeerd.
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
      // Hard check: als socket niet ready is, niets claimen. Zo blijven rows
      // in 'pending' hangen totdat de connectie terug is.
      const initialSock = resolveSocket();
      if (!isSocketReady(initialSock)) {
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
        let transientReleased = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !sent; attempt++) {
          // Wacht (met bounded timeout) op een werkende socket voor elke poging.
          const sock = await waitForSocketReady(
            resolveSocket,
            logger,
            SOCKET_READY_WAIT_MS,
          );
          if (!sock) {
            lastError = "socket not ready after wait";
            logger.warn(
              `[queue-processor] id=${row.id} socket still down after ${SOCKET_READY_WAIT_MS}ms, releasing to pending`,
            );
            releaseOutgoingToPending(row.id);
            transientReleased = true;
            break;
          }

          try {
            const result = await sendWhatsAppMessage(
              logger,
              sock,
              row.recipient_jid,
              row.content,
            );
            if (result && result.key && result.key.id) {
              markOutgoingSent(row.id, result.key.id);
              logger.info(
                `[queue-processor] sent id=${row.id} to=${row.recipient_jid} attempt=${attempt} waId=${result.key.id}`,
              );
              sent = true;
              break;
            } else {
              lastError = "sendMessage returned no key";
              logger.warn(
                `[queue-processor] attempt ${attempt}/${MAX_ATTEMPTS} failed id=${row.id}: no key`,
              );
            }
          } catch (err: any) {
            lastError = err?.message ?? String(err);
            const transient = isTransientSocketError(err);
            logger.warn(
              { err, transient },
              `[queue-processor] attempt ${attempt}/${MAX_ATTEMPTS} error id=${row.id} (transient=${transient}): ${lastError}`,
            );

            // Transient = socket dicht tijdens send. Row terug naar pending,
            // niet als attempt tellen, zodat reconnect + retry kan.
            if (transient) {
              releaseOutgoingToPending(row.id);
              transientReleased = true;
              break;
            }
          }

          if (!sent && attempt < MAX_ATTEMPTS) {
            // Exponential backoff (1s, 2s, 4s, 8s, ...)
            const backoff = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
            await sleep(backoff);
          }
        }

        if (!sent && !transientReleased) {
          incrementOutgoingAttempt(row.id);
          markOutgoingFailed(
            row.id,
            lastError ?? `failed after ${MAX_ATTEMPTS} attempts`,
          );
          logger.error(
            `[queue-processor] permanent failure id=${row.id} to=${row.recipient_jid} after ${MAX_ATTEMPTS} attempts: ${lastError}`,
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
    `[queue-processor] started (poll=${POLL_INTERVAL_MS}ms, batch=${BATCH_SIZE}, maxAttempts=${MAX_ATTEMPTS})`,
  );

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
      logger.info("[queue-processor] stopped");
    },
  };
}
