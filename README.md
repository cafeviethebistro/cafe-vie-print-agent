# Café Vie Print Agent — Desktop App

A cross-platform desktop application (Windows + macOS) that delivers print
jobs from the Café Vie cloud to venue LAN printers. Venue managers install it
once; no terminal, npm, or .env files required.

## Features

- System tray icon (green = connected, grey = disconnected)
- Status window: connection status, last heartbeat, jobs processed
- One-click printer test
- Log viewer (last 300 lines)
- Settings UI (API URL + token — no .env needed)
- Auto-start at login
- Auto-update via GitHub Releases

---

## Getting the installers

Download the latest release from the **GitHub Releases** page:

| Platform | File |
|---|---|
| Windows 10/11 (64-bit) | `CafeVie-Print-Agent-Setup-X.X.X.exe` |
| macOS (Intel + Apple Silicon) | `CafeVie-Print-Agent-X.X.X.dmg` |

### First-time setup (venue manager)

1. **Download and run the installer** — on Windows, click through the wizard;
   on macOS, drag to Applications.
2. The app starts automatically and a **CV** icon appears in your system tray.
3. The setup screen opens automatically — enter:
   - **API URL**: your Café Vie app URL (e.g. `https://your-app.replit.app`)
   - **Agent Token**: from Back Office → Settings → Printers → Print Agent → Register new agent
4. Click **Connect** — the status dot turns green within a few seconds.
5. Click **Test Printer** to confirm printing works.

---

## Building the installers

### Via GitHub Actions (recommended)

1. Push this repository to GitHub.
2. Update `package.json` → `"build"` → `"publish"` with your GitHub org/repo name.
3. Tag a release:
   ```bash
   git tag agent-v1.0.0
   git push --tags
   ```
4. GitHub Actions builds the `.exe` and `.dmg` automatically and attaches them
   to a GitHub Release. Download from the Releases page.

### Locally (requires the matching OS)

Windows installer (run on Windows):
```bash
cd print-agent-app
npm install
npm run dist:win
# Output: dist/CafeVie-Print-Agent-Setup-X.X.X.exe
```

macOS installer (run on macOS):
```bash
cd print-agent-app
npm install
npm run dist:mac
# Output: dist/CafeVie-Print-Agent-X.X.X.dmg
```

> **Note:** You cannot build a `.exe` on macOS or a `.dmg` on Windows.
> Use GitHub Actions (runs on both) or a physical machine of each type.

### Development mode (any OS)

```bash
cd print-agent-app
npm install
npm run dev     # launches Electron with live-rebuild
```

---

## Auto-update

The app checks for updates at startup using `electron-updater` against your
GitHub Releases page. When a new release is published, users see a banner:
"Update downloaded — restart to apply." The update installs silently on restart.

To release an update: bump the version in `package.json`, tag it, and push.

---

## Code signing (optional but recommended)

Without code signing:
- **Windows**: shows a SmartScreen warning on first run (user can click "More info → Run anyway")
- **macOS**: requires right-click → Open on first launch

With code signing (requires Apple Developer account / Windows EV certificate):
- Configure the secrets listed in `.github/workflows/build-installer.yml`
- macOS: `MAC_CERTS`, `MAC_CERTS_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- Windows: add `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` to the workflow

---

## Architecture

```
Café Vie cloud API
        │
        │  HTTPS (polling every 3s)
        ▼
  Print Agent (this app)
        │
        │  TCP port 9100
        ▼
  ESC/POS thermal printer
  (Star TSP, Epson TM, etc.)
```

The agent polls `GET /api/print-agent/jobs`, decodes base64 ESC/POS payloads,
and sends them to the printer via TCP. On success it calls
`POST /api/print-agent/jobs/:id/complete`; on failure it calls
`POST /api/print-agent/jobs/:id/fail` (the server auto-retries up to 3 times
before marking the job as permanently failed).
