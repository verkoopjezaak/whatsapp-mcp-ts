import { pino, type Logger } from "pino";
import { startMcpServer } from "./mcp.ts";
import { startDaemon } from "./daemon.ts";
import type { WhatsAppSocket } from "./whatsapp.ts";

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
 * Start the MCP server. Accepts an already-initialized WhatsApp socket and
 * loggers, so it can share a process with the daemon (Phase 1 behaviour).
 */
export async function runMcpServer(params: {
  whatsappSocket: WhatsAppSocket;
  mcpLogger: Logger;
  waLogger: Logger;
}): Promise<void> {
  const { whatsappSocket, mcpLogger, waLogger } = params;

  mcpLogger.info("Starting MCP server...");
  await startMcpServer(whatsappSocket, mcpLogger, waLogger);
  mcpLogger.info("MCP Server started and listening.");
}

/**
 * Entry point when this file is executed directly (e.g. `npm run mcp`).
 *
 * In Phase 1 the MCP server still needs a live WhatsApp socket in the same
 * process, so we bootstrap the daemon in-process. In later phases this will
 * be replaced by an IPC/DB connection to a separately-running daemon.
 */
async function runStandalone() {
  const mcpLogger = createLogger("mcp-logs.txt");
  const waLogger = createLogger("wa-logs.txt");
  const daemonLogger = createLogger("daemon-logs.txt");

  mcpLogger.info("Starting MCP server (standalone mode)...");

  try {
    const { whatsappSocket } = await startDaemon({
      waLogger,
      daemonLogger,
    });
    await runMcpServer({ whatsappSocket, mcpLogger, waLogger });
    mcpLogger.info("MCP standalone setup complete.");
  } catch (error: any) {
    mcpLogger.fatal(
      { err: error },
      "Failed during MCP standalone startup"
    );
    process.exit(1);
  }

  function shutdown(signal: string) {
    mcpLogger.info(`Received ${signal}. Shutting down MCP server...`);
    waLogger.flush();
    mcpLogger.flush();
    daemonLogger.flush();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

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
