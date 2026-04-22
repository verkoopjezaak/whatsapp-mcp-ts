import { pino, type Logger } from "pino";
import { initializeDatabase } from "./database.ts";
import { startWhatsAppConnection, type WhatsAppSocket } from "./whatsapp.ts";
import { startQueueProcessor } from "./queue-processor.ts";

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || ".";

function createLogger(filename: string): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL || "info",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination(`${dataDir}/${filename}`)
  );
}

/**
 * Start the WhatsApp daemon: initializes the database and opens the WhatsApp
 * connection. Returns the live socket plus the logger used for WhatsApp events
 * so callers (e.g. the MCP server) can reuse them.
 *
 * In Phase 1 this is called from main.ts alongside startMcpServer. In later
 * phases the daemon can run as a standalone process.
 */
export async function startDaemon(options?: {
  waLogger?: Logger;
  daemonLogger?: Logger;
}): Promise<{
  whatsappSocket: WhatsAppSocket;
  waLogger: Logger;
  daemonLogger: Logger;
}> {
  const waLogger = options?.waLogger ?? createLogger("wa-logs.txt");
  const daemonLogger =
    options?.daemonLogger ?? createLogger("daemon-logs.txt");

  daemonLogger.info("Initializing database...");
  initializeDatabase();
  daemonLogger.info("Database initialized successfully.");

  daemonLogger.info("Attempting to connect to WhatsApp...");

  // Mutable holder voor de huidige socket. Elke reconnect roept makeWASocket
  // opnieuw aan en levert een NIEUW object op. Zonder deze holder blijft de
  // queue-processor vasthouden aan het eerste socket-object, dat sluit zodra
  // WhatsApp een restartRequired (code 515) of timeout forceert. Gevolg:
  // ontvangen werkt (nieuwe socket heeft eigen event handlers) maar versturen
  // faalt stilzwijgend omdat isSocketReady() op de dode socket false returnt.
  let currentSocket: WhatsAppSocket | null = null;
  const setSocket = (s: WhatsAppSocket) => {
    currentSocket = s;
    daemonLogger.info("[daemon] socket holder updated (reconnect registered)");
  };
  const getSocket = (): WhatsAppSocket | null => currentSocket;

  const whatsappSocket = await startWhatsAppConnection(waLogger, setSocket);
  daemonLogger.info("WhatsApp connection process initiated.");

  // Start queue processor: leest pending outgoing_messages en verstuurt via
  // de WhatsApp socket. Nodig zodra MCP-server USE_QUEUE=1 gebruikt (fase 4).
  // Altijd aan zodat queue ook werkt als legacy main.ts wrapper nog draait.
  // getSocket geeft bij elke tick de CURRENT socket terug, zodat reconnects
  // transparant zijn voor de processor.
  startQueueProcessor({ sock: whatsappSocket, logger: waLogger, getSocket });

  return { whatsappSocket, waLogger, daemonLogger };
}

/**
 * Entry point when this file is executed directly (e.g. `npm run daemon`).
 * Keeps the process alive for as long as the WhatsApp connection runs.
 */
async function runStandalone() {
  const daemonLogger = createLogger("daemon-logs.txt");
  const waLogger = createLogger("wa-logs.txt");

  daemonLogger.info("Starting WhatsApp daemon (standalone mode)...");

  try {
    await startDaemon({ waLogger, daemonLogger });
    daemonLogger.info("Daemon running. Awaiting WhatsApp events...");
  } catch (error: any) {
    daemonLogger.fatal(
      { err: error },
      "Failed during daemon initialization"
    );
    process.exit(1);
  }

  function shutdown(signal: string) {
    daemonLogger.info(`Received ${signal}. Shutting down daemon...`);
    waLogger.flush();
    daemonLogger.flush();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Detect whether this module is the entrypoint (ESM-safe check).
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const invoked = process.argv[1].replace(/\\/g, "/");
    const self = import.meta.url
      .replace(/^file:\/\//, "")
      .replace(/\\/g, "/");
    return invoked === self || self.endsWith(invoked);
  } catch {
    return false;
  }
})();

if (isMain) {
  runStandalone();
}
