import { contextBridge, ipcRenderer } from "electron";

export interface Settings {
  apiUrl: string;
  agentToken: string;
  pollIntervalMs: number;
  launchAtStartup: boolean;
}

export interface AgentState {
  status: "setup" | "connecting" | "connected" | "auth_error" | "disconnected";
  lastHeartbeatAt: string | null;
  jobsToday: number;
  jobsTotal: number;
  lastError: string | null;
}

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
}

contextBridge.exposeInMainWorld("agent", {
  // Queries (request/reply)
  getState:    (): Promise<AgentState>  => ipcRenderer.invoke("get-state"),
  getLogs:     (): Promise<LogEntry[]>  => ipcRenderer.invoke("get-logs"),
  getSettings: (): Promise<Settings>    => ipcRenderer.invoke("get-settings"),

  // Actions
  saveSettings:  (s: Partial<Settings>) => ipcRenderer.invoke("save-settings", s),
  testPrint:     ()                      => ipcRenderer.invoke("test-print"),
  restartAgent:  ()                      => ipcRenderer.invoke("restart-agent"),
  checkUpdates:  ()                      => ipcRenderer.invoke("check-updates"),
  openBackOffice:()                      => ipcRenderer.invoke("open-back-office"),

  // Push events from main → renderer
  onState:         (cb: (s: AgentState) => void) => ipcRenderer.on("state",           (_e, s) => cb(s)),
  onLog:           (cb: (e: LogEntry)   => void) => ipcRenderer.on("log",             (_e, e) => cb(e)),
  onUpdateReady:   (cb: () => void)              => ipcRenderer.on("update-downloaded",(_e)    => cb()),
  onUpdateAvail:   (cb: () => void)              => ipcRenderer.on("update-available", (_e)    => cb()),
});
