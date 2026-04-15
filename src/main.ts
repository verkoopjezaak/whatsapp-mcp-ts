import { pino } from "pino";
import { startDaemon } from "./daemon.ts";
import { runMcpServer } from "./mcp-server.ts";

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || ".";

const waLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/wa-logs.txt`)
);

const mcpLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/mcp-logs.txt`)
);

const daemonLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/daemon-logs.txt`)
);

/**
 * Combined entry point: boots the WhatsApp daemon AND the MCP server in a
 * single process. Keeps backwards-compatible behaviour with the pre-split
 * main.ts. Later phases may run daemon and MCP server as separate processes;
 * this file remains the "run everything together" convenience entry.
 */
async function main() {
  mcpLogger.info("Starting WhatsApp MCP Server (combined mode)...");

  try {
    const { whatsappSocket } = await startDaemon({
      waLogger,
      daemonLogger,
    });
    await runMcpServer({ whatsappSocket, mcpLogger, waLogger });
    mcpLogger.info("Application setup complete. Running...");
  } catch (error: any) {
    mcpLogger.fatal(
      { err: error },
      "Failed during initialization or startup"
    );
    waLogger.flush();
    mcpLogger.flush();
    daemonLogger.flush();
    process.exit(1);
  }
}

async function shutdown(signal: string) {
  mcpLogger.info(`Received ${signal}. Shutting down gracefully...`);

  waLogger.flush();
  mcpLogger.flush();
  daemonLogger.flush();

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  mcpLogger.fatal({ err: error }, "Unhandled error during application startup");
  waLogger.flush();
  mcpLogger.flush();
  daemonLogger.flush();
  process.exit(1);
});
