import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from "@whiskeysockets/baileys";
import { pino } from "pino";
import path from "node:path";
import qrcode from "qrcode-terminal";

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || path.join(import.meta.dirname, "..");
const AUTH_DIR = path.join(dataDir, "auth_info");

const logger = pino({ level: "warn" });

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log("Verbinden met WhatsApp...");
  console.log("Wacht op QR-code...\n");

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: state.keys,
    },
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === "open") {
      console.log("\n✅ WhatsApp succesvol gekoppeld!");
      console.log("Je kunt dit script nu sluiten (Ctrl+C) en een nieuwe Claude Code sessie starten.");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log("Uitgelogd. Start opnieuw.");
        process.exit(0);
      }
    }
  });
}

main().catch(console.error);
