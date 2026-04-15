# WhatsApp daemon installatie (Fase 4)

Vanaf Fase 4 draait de Baileys-verbinding als user systemd-service, niet meer als stdio child van Claude Code. Dit lost de "meerdere Claude sessies = auth conflict" situatie op.

## Installatie

```bash
# 1. Kopieer de unit naar je user systemd map
mkdir -p ~/.config/systemd/user
cp contrib/whatsapp-daemon.service ~/.config/systemd/user/

# 2. Maak log-directory
mkdir -p ~/.local/share/whatsapp-daemon

# 3. Reload user systemd, enable + start service
systemctl --user daemon-reload
systemctl --user enable --now whatsapp-daemon.service

# 4. Zorg dat user-lingering aan staat (laat service draaien na logout)
sudo loginctl enable-linger $USER   # alleen eenmalig nodig

# 5. Verifieer
systemctl --user status whatsapp-daemon
tail -f ~/.local/share/whatsapp-daemon/stdout.log
```

## Cutover MCP server naar no-daemon mode

Na het starten van de systemd daemon moet de stdio MCP child NIET meer zelf een WhatsApp socket openen (anders auth conflict). Update `~/.claude.json` of project `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": [
        "--experimental-sqlite",
        "--experimental-strip-types",
        "--no-warnings",
        "/home/umbrel/mcp-servers/whatsapp-mcp-ts/src/mcp-server.ts"
      ],
      "env": {
        "WHATSAPP_MCP_NO_DAEMON": "1"
      }
    }
  }
}
```

`WHATSAPP_MCP_NO_DAEMON=1` zet automatisch ook `USE_QUEUE=1`. De MCP-server leest dan uit SQLite en schrijft send_message naar de outgoing_messages queue.

## Troubleshooting

- **Daemon start niet**: check `~/.local/share/whatsapp-daemon/stderr.log`.
- **Auth conflict tijdens eerste cutover**: stop eerst oude processen (`pkill -f main.ts`), dan `systemctl --user restart whatsapp-daemon`.
- **QR-scan gevraagd**: auth_info is kwijt. Check `auth_info/creds.json` bestaat. Backup maken voor je een migratie doet.
- **Berichten worden niet verstuurd**: check of `WHATSAPP_MCP_NO_DAEMON=1` ook `USE_QUEUE=1` triggert; queue processor loopt elke 2s in daemon-logs.

## Rollback

```bash
systemctl --user stop whatsapp-daemon
systemctl --user disable whatsapp-daemon
```

Zet `~/.claude.json` terug naar oude `main.ts` command. Claude sessie herstarten.
