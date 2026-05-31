import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  safeStorage,
} from "electron";
import { autoUpdater } from "electron-updater";
import Store from "electron-store";
import * as net from "net";
import * as path from "path";
import { TRAY_ON_PNG, TRAY_OFF_PNG } from "./tray-icons.generated";

// ── Types ─────────────────────────────────────────────────────────────────────

interface StoreSchema {
  apiUrl: string;
  agentToken: string;          // plain text fallback (when safeStorage unavailable)
  agentTokenEnc: string;       // safeStorage-encrypted token, base64
  pollIntervalMs: number;
  launchAtStartup: boolean;
}

interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
}

type AgentStatus =
  | "setup"
  | "connecting"
  | "connected"
  | "auth_error"
  | "disconnected";

interface AgentState {
  status: AgentStatus;
  lastHeartbeatAt: string | null;
  jobsToday: number;
  jobsTotal: number;
  lastError: string | null;
}

interface Job {
  id: number;
  jobType: string;
  printer: { name: string; ipAddress: string | null; port: number } | null;
  data: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const HEARTBEAT_MS   = 30_000;
const TCP_TIMEOUT_MS =  8_000;
const RECONNECT_MS   = 30_000;   // retry delay after connection failure
const MAX_LOGS       =   300;

// ── Persistent store ──────────────────────────────────────────────────────────

const store = new Store<StoreSchema>({
  schema: {
    apiUrl:         { type: "string",  default: "" },
    agentToken:     { type: "string",  default: "" },
    agentTokenEnc:  { type: "string",  default: "" },
    pollIntervalMs: { type: "number",  default: 3000 },
    launchAtStartup:{ type: "boolean", default: true },
  },
});

// ── Secure token helpers ──────────────────────────────────────────────────────
// Uses Electron's safeStorage which delegates to:
//   macOS  → Keychain
//   Windows → Windows Data Protection API (DPAPI, per-user)
//   Linux  → libsecret / kwallet if available, plain text otherwise

function getToken(): string {
  if (safeStorage.isEncryptionAvailable()) {
    const enc = store.get("agentTokenEnc");
    if (enc) {
      try { return safeStorage.decryptString(Buffer.from(enc, "base64")); }
      catch { /* corrupt — fall through */ }
    }
    // Migrate any previously-stored plain-text token
    const plain = store.get("agentToken");
    if (plain) {
      setToken(plain);
      store.set("agentToken", "");
      return plain;
    }
    return "";
  }
  // safeStorage not available — use plain text
  return store.get("agentToken");
}

function setToken(token: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      store.set("agentTokenEnc", safeStorage.encryptString(token).toString("base64"));
      store.set("agentToken",    ""); // clear any plain-text copy
      return;
    } catch (err) {
      addLog("warn", `Could not encrypt token (OS keychain unavailable): ${err}`);
    }
  }
  store.set("agentToken", token);
}

function isConfigured(): boolean {
  return !!(store.get("apiUrl") && (getToken() !== ""));
}

// ── Global state ──────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

let agentState: AgentState = {
  status: "disconnected",
  lastHeartbeatAt: null,
  jobsToday: 0,
  jobsTotal: 0,
  lastError: null,
};

const logs: LogEntry[] = [];
let pollTimer:      ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout>  | null = null;
let polling = false;

// ── Logging ───────────────────────────────────────────────────────────────────

function addLog(level: LogEntry["level"], msg: string) {
  const entry: LogEntry = { ts: new Date().toISOString(), level, msg };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  mainWindow?.webContents.send("log", entry);
  console[level === "info" ? "log" : level](`[${level.toUpperCase()}] ${msg}`);
}

// ── State helpers ─────────────────────────────────────────────────────────────

function patchState(patch: Partial<AgentState>) {
  agentState = { ...agentState, ...patch };
  mainWindow?.webContents.send("state", agentState);
  updateTray();
}

function setStatus(status: AgentStatus, lastError?: string) {
  patchState({ status, lastError: lastError ?? agentState.lastError });
}

// ── Tray icon (inline PNG — works on Windows, macOS, Linux) ───────────────────

function getTrayImage(connected: boolean): Electron.NativeImage {
  return nativeImage.createFromDataURL(connected ? TRAY_ON_PNG : TRAY_OFF_PNG);
}

function updateTray() {
  if (!tray) return;
  const on = agentState.status === "connected";
  tray.setImage(getTrayImage(on));
  tray.setToolTip(
    on
      ? "Café Vie Print Agent — Connected"
      : agentState.status === "auth_error"
        ? "Café Vie Print Agent — Auth error (open window)"
        : "Café Vie Print Agent — Disconnected"
  );
}

function buildTrayMenu(): Electron.Menu {
  const configured = isConfigured();
  const connected  = agentState.status === "connected";
  return Menu.buildFromTemplate([
    {
      label: connected
        ? "● Connected"
        : agentState.status === "auth_error"
          ? "⚠ Auth error — check token"
          : "○ Not connected",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Open Status Window",
      click: () => { mainWindow?.show(); mainWindow?.focus(); },
    },
    {
      label: "Test Printer",
      enabled: configured && connected,
      click: () => runTestPrint(),
    },
    { type: "separator" },
    {
      label: "Launch at Login",
      type: "checkbox",
      checked: store.get("launchAtStartup"),
      click: (item) => {
        store.set("launchAtStartup", item.checked);
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
      },
    },
    { type: "separator" },
    { label: "Quit", role: "quit" },
  ]);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function baseUrl() { return store.get("apiUrl").replace(/\/$/, ""); }
function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    "Content-Type": "application/json",
  };
}

async function apiGet(p: string) {
  return fetch(`${baseUrl()}${p}`, { headers: authHeaders() });
}
async function apiPost(p: string, body?: unknown) {
  return fetch(`${baseUrl()}${p}`, {
    method: "POST",
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Friendly TCP error messages ───────────────────────────────────────────────

function friendlyTcpError(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case "ECONNREFUSED":
      return `Printer refused connection — is it powered on and online? (${err.message})`;
    case "ETIMEDOUT":
      return `Printer connection timed out — check the IP address is correct (${err.message})`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `Printer not reachable — check network cable / Wi-Fi (${err.message})`;
    case "ENOTFOUND":
      return `Printer hostname not found — use an IP address instead (${err.message})`;
  }
  if (err.message.includes("TCP timeout")) {
    return `Printer did not respond within ${TCP_TIMEOUT_MS / 1000}s — check IP and cable`;
  }
  return err.message;
}

// ── TCP printer delivery ──────────────────────────────────────────────────────

function sendTCP(ip: string, port: number, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.connect(port, ip, () => {
      socket.write(data, (err) => {
        if (err) { socket.destroy(); settle(() => reject(err)); }
        else      { socket.end(); }
      });
    });
    socket.on("timeout", () => {
      socket.destroy();
      settle(() => reject(new Error(`TCP timeout after ${TCP_TIMEOUT_MS}ms`)));
    });
    socket.on("error", (err) => settle(() => reject(friendlyTcpError(err) !== err.message
      ? Object.assign(new Error(friendlyTcpError(err)), { original: err })
      : err
    )));
    socket.on("close", () => settle(resolve));
  });
}

// ── Job processing ────────────────────────────────────────────────────────────

async function processJob(job: Job): Promise<void> {
  const { printer, data } = job;
  if (!printer)           throw new Error("Job has no printer attached");
  if (!printer.ipAddress) throw new Error(`Printer "${printer.name}" has no IP address — add one in Settings → Printers`);
  if (!data)              throw new Error("Job has no print data");

  const buf = Buffer.from(data, "base64");
  addLog("info", `  → ${printer.name} at ${printer.ipAddress}:${printer.port} — ${buf.length} bytes`);
  await sendTCP(printer.ipAddress, printer.port, buf);
}

// ── Poll cycle ────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    let res: Response;
    try {
      res = await apiGet("/api/print-agent/jobs");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setStatus("disconnected", msg);
      addLog("error", `Connection lost: ${msg}`);
      return;
    }

    if (res.status === 401) {
      setStatus("auth_error", "Token is incorrect or has been revoked");
      addLog("error", "Authentication failed — open Settings and re-enter your agent token");
      stopAgent();
      return;
    }
    if (!res.ok) { addLog("warn", `Server returned HTTP ${res.status}`); return; }

    // Reconnected after being offline
    if (agentState.status !== "connected") {
      setStatus("connected");
      addLog("info", "✅ Connection restored");
    }

    const { jobs = [] } = (await res.json()) as { jobs: Job[] };
    if (jobs.length === 0) return;

    addLog("info", `📋 ${jobs.length} job(s) in queue`);

    for (const job of jobs) {
      addLog("info", `Processing job #${job.id} [${job.jobType}]`);
      try {
        await processJob(job);
        await apiPost(`/api/print-agent/jobs/${job.id}/complete`);
        patchState({ jobsToday: agentState.jobsToday + 1, jobsTotal: agentState.jobsTotal + 1 });
        addLog("info", `✅ Job #${job.id} printed successfully`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        addLog("error", `❌ Job #${job.id} failed: ${reason}`);
        try {
          const failRes = await apiPost(`/api/print-agent/jobs/${job.id}/fail`, { errorMessage: reason });
          if (failRes.ok) {
            const { requeued } = (await failRes.json()) as { requeued?: boolean };
            addLog(
              requeued ? "warn" : "error",
              requeued
                ? `  ↩ Job #${job.id} will be retried automatically`
                : `  🚫 Job #${job.id} permanently failed — retry from Back Office → Printers`
            );
          }
        } catch { /* fail-report is best-effort */ }
      }
    }
  } finally {
    polling = false;
  }
}

async function heartbeat(): Promise<void> {
  try {
    const res = await apiPost("/api/print-agent/heartbeat");
    if (res.ok) {
      patchState({ lastHeartbeatAt: new Date().toISOString() });
    } else {
      addLog("warn", `Heartbeat returned HTTP ${res.status}`);
    }
  } catch (err) {
    addLog("warn", `Heartbeat failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Agent lifecycle ───────────────────────────────────────────────────────────

function stopAgent() {
  if (pollTimer)      { clearInterval(pollTimer);      pollTimer      = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer);  reconnectTimer = null; }
}

function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled
  addLog("info", `Retrying connection in ${RECONNECT_MS / 1000}s…`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; startAgent(); }, RECONNECT_MS);
}

async function startAgent(): Promise<void> {
  stopAgent();

  if (!isConfigured()) {
    setStatus("setup");
    addLog("warn", "Not configured — open Settings to enter your API URL and agent token");
    mainWindow?.show();
    return;
  }

  setStatus("connecting");
  addLog("info", `Connecting to ${store.get("apiUrl")}…`);

  let res: Response;
  try {
    res = await apiGet("/api/print-agent/jobs");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Connection failed";
    setStatus("disconnected", msg);
    addLog("error", `Cannot reach server: ${msg}`);
    scheduleReconnect(); // ← auto-retry if offline at startup
    return;
  }

  if (res.status === 401) {
    setStatus("auth_error", "Invalid or revoked token");
    addLog("error", "Authentication failed — open Settings and check your agent token");
    return; // do not retry — bad token won't improve by itself
  }
  if (!res.ok) {
    setStatus("disconnected", `HTTP ${res.status}`);
    addLog("error", `Server returned HTTP ${res.status}`);
    scheduleReconnect();
    return;
  }

  setStatus("connected");
  addLog("info", `✅ Connected to ${store.get("apiUrl")}`);

  await heartbeat();

  const ms = Math.max(1000, store.get("pollIntervalMs"));
  pollTimer      = setInterval(poll,      ms);
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  await poll();
}

// ── Test print ────────────────────────────────────────────────────────────────

async function runTestPrint(): Promise<void> {
  mainWindow?.show();
  addLog("info", "Queuing test print…");
  try {
    const res = await apiGet("/api/printers");
    if (!res.ok) { addLog("error", `Could not fetch printers (HTTP ${res.status})`); return; }
    const printers = (await res.json()) as { id: number; name: string; enabled: boolean }[];
    const enabled  = printers.filter((p) => p.enabled);
    if (!enabled.length) {
      addLog("warn", "No enabled printers found — add and enable a printer in Back Office → Settings → Printers");
      return;
    }
    for (const p of enabled) {
      const r = await apiPost(`/api/printers/${p.id}/test`);
      addLog(
        r.ok ? "info" : "error",
        r.ok
          ? `Test job queued for "${p.name}" — watch for ✅ above`
          : `Could not queue test for "${p.name}": HTTP ${r.status}`
      );
    }
  } catch (err) {
    addLog("error", `Test print error: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Daily counter reset ───────────────────────────────────────────────────────

function scheduleDailyReset() {
  const now      = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  setTimeout(() => {
    patchState({ jobsToday: 0 });
    scheduleDailyReset();
  }, midnight.getTime() - now.getTime());
}

// ── IPC ───────────────────────────────────────────────────────────────────────

function setupIPC() {
  ipcMain.handle("get-state", () => agentState);
  ipcMain.handle("get-logs",  () => logs);

  ipcMain.handle("get-settings", () => ({
    apiUrl:          store.get("apiUrl"),
    agentToken:      getToken(),          // decrypt before returning to UI
    pollIntervalMs:  store.get("pollIntervalMs"),
    launchAtStartup: store.get("launchAtStartup"),
  }));

  ipcMain.handle("save-settings", (_e, s: { apiUrl?: string; agentToken?: string; pollIntervalMs?: number; launchAtStartup?: boolean }) => {
    if (s.apiUrl         !== undefined) store.set("apiUrl",          s.apiUrl);
    if (s.agentToken     !== undefined) setToken(s.agentToken);     // encrypt before storing
    if (s.pollIntervalMs !== undefined) store.set("pollIntervalMs",  s.pollIntervalMs);
    if (s.launchAtStartup!== undefined) {
      store.set("launchAtStartup", s.launchAtStartup);
      app.setLoginItemSettings({ openAtLogin: s.launchAtStartup, openAsHidden: true });
    }
    startAgent();
    return { ok: true };
  });

  ipcMain.handle("test-print",      () => { runTestPrint(); return { ok: true }; });
  ipcMain.handle("restart-agent",   () => { startAgent();   return { ok: true }; });
  ipcMain.handle("open-back-office",() => {
    const url = store.get("apiUrl");
    if (url) shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.handle("check-updates", () => {
    if (app.isPackaged) {
      try { autoUpdater.checkForUpdatesAndNotify(); }
      catch (err) { addLog("warn", `Update check: ${err instanceof Error ? err.message : err}`); }
    } else {
      addLog("info", "Auto-update only runs in packaged builds");
    }
    return { ok: true };
  });
}

// ── BrowserWindow ─────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 700,
    minWidth: 400,
    minHeight: 560,
    title: "Café Vie Print Agent",
    backgroundColor: "#faf8f5",
    show: false, // ← hidden by default; shown explicitly when needed
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Minimize to tray on close — don't actually quit
  mainWindow.on("close", (e) => {
    e.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.once("ready-to-show", () => {
    // First-run: show setup wizard so venue manager can enter URL + token.
    // Subsequent startups (including auto-start at login): stay hidden in tray —
    // user opens via tray icon click or right-click → Open Status Window.
    if (!isConfigured()) mainWindow?.show();
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(getTrayImage(false));
  tray.setContextMenu(buildTrayMenu());
  // Left-click toggles the window
  tray.on("click", () => {
    mainWindow?.isVisible() ? mainWindow.hide() : (mainWindow?.show(), mainWindow?.focus());
  });
  // Rebuild on right-click to reflect latest state
  tray.on("right-click", () => tray?.setContextMenu(buildTrayMenu()));
}

// ── Auto-updater ──────────────────────────────────────────────────────────────

function setupUpdater() {
  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", () => {
    mainWindow?.webContents.send("update-available");
    addLog("info", "Update available — downloading in background…");
  });
  autoUpdater.on("update-downloaded", () => {
    mainWindow?.webContents.send("update-downloaded");
    addLog("info", "✅ Update ready — will install on next restart");
  });
  // Catch "no releases yet" / misconfigured publish gracefully
  autoUpdater.on("error", (err) => {
    const msg = err?.message ?? String(err);
    const isNoRelease = msg.includes("404") || msg.includes("No published versions");
    addLog("warn",
      isNoRelease
        ? "Auto-update: no releases published yet"
        : `Auto-update: ${msg}`
    );
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  setupIPC();
  setupUpdater();
  createWindow();
  createTray();
  scheduleDailyReset();

  // Apply autostart setting (no-op if not changed, but harmless to re-apply)
  app.setLoginItemSettings({
    openAtLogin: store.get("launchAtStartup"),
    openAsHidden: true, // macOS: start hidden; Windows: uses startup registry key
  });

  // Safe update check — silently skips if GitHub Releases not configured yet
  if (app.isPackaged) {
    try { autoUpdater.checkForUpdatesAndNotify(); }
    catch (err) { addLog("warn", `Auto-update unavailable: ${err instanceof Error ? err.message : err}`); }
  }

  await startAgent();
});

// Stay alive in system tray even with no visible windows
app.on("window-all-closed", () => { /* intentionally empty — app lives in tray */ });
app.on("activate", () => { mainWindow?.show(); }); // macOS dock click

export {};
