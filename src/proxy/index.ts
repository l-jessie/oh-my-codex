/**
 * OhMyCodex Proxy Server
 * Connects standard Codex requests to selected API providers (DeepSeek, SiliconFlow, OpenAI, Custom).
 * Hosts the local glassmorphic dashboard at http://localhost:16868/dashboard.
 * Broadcasts real-time terminal logs to dashboard sessions using SSE.
 */

import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";

import {
  responsesToChat,
  chatCompletionToResponse,
  extractNamespaceMap,
  ResponsesStreamState,
  processVisionBridge
} from "./translator.js";

import { getDashboardHtml } from "./dashboard.js";

interface ProviderConfig {
  uuidId: string;
  name: string;
  base_url: string;
  api_key: string;
  models?: string[];
  vision?: {
    mode?: string;
    model?: string;
    base_url?: string;
    api_key?: string;
  };
  // Legacy fields for backward compat
  vision_model?: string;
  id?: string;
}

interface ProxyConfig {
  active_provider_uuidId?: string;
  log_level?: LogLevel;
}

const DEFAULT_MODEL = "gpt-5.5";

// ─── Logging infrastructure ───
export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const CONFIG_DIR = join(homedir(), ".ohmycodex");

const LEGACY_CONFIG_DIR = join(homedir(), ".opencodex");
const LOGS_DIR = join(CONFIG_DIR, "logs");

function ensureDirs() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}
ensureDirs();

// One-time migration from legacy .opencodex dir
function migrateLegacy() {
  try {
    const legacyProviders = join(LEGACY_CONFIG_DIR, "providers.json");
    const newSettings = join(CONFIG_DIR, "settings.json");
    if (existsSync(legacyProviders) && !existsSync(newSettings)) {
      writeFileSync(newSettings, readFileSync(legacyProviders, "utf-8"), "utf-8");
    }
    const legacyCatalog = join(LEGACY_CONFIG_DIR, "custom_model_catalog.json");
    const newCatalog = join(CONFIG_DIR, "custom_model_catalog.json");
    if (existsSync(legacyCatalog) && !existsSync(newCatalog)) {
      writeFileSync(newCatalog, readFileSync(legacyCatalog, "utf-8"), "utf-8");
    }
  } catch { /* best effort */ }
}
migrateLegacy();

// ─── Per-provider directory manager ───
const PROVIDERS_DIR = join(CONFIG_DIR, "providers");

function ensureProvidersDir() {
  if (!existsSync(PROVIDERS_DIR)) mkdirSync(PROVIDERS_DIR, { recursive: true });
}
ensureProvidersDir();

class ProviderManager {
  private providersDir = PROVIDERS_DIR;

  list(): ProviderConfig[] {
    if (!existsSync(this.providersDir)) return [];
    const dirs = readdirSync(this.providersDir).filter(d => {
      const full = join(this.providersDir, d);
      return existsSync(full) && existsSync(join(full, "config.json"));
    });
    return dirs.map(d => this.load(d)).filter(Boolean) as ProviderConfig[];
  }

  load(uuidId: string): ProviderConfig | null {
    const dir = join(this.providersDir, uuidId);
    const cfgPath = join(dir, "config.json");
    if (!existsSync(cfgPath)) return null;
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      let vision = { mode: "default", model: "", base_url: "", api_key: "" };
      const visionPath = join(dir, "vision.json");
      if (existsSync(visionPath)) {
        vision = JSON.parse(readFileSync(visionPath, "utf-8"));
      }
      return {
        uuidId: cfg.uuidId || uuidId,
        name: cfg.name || "Untitled",
        base_url: cfg.base_url || "",
        api_key: cfg.api_key || "",
        models: cfg.models || [],
        vision,
      };
    } catch { return null; }
  }

  create(name?: string): ProviderConfig {
    const uuidId = crypto.randomUUID();
    const dir = join(this.providersDir, uuidId);
    mkdirSync(dir, { recursive: true });
    const provider: ProviderConfig = {
      uuidId,
      name: name || "New Provider",
      base_url: "",
      api_key: "",
      models: [],
      vision: { mode: "default", model: "", base_url: "", api_key: "" },
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      uuidId, name: provider.name, base_url: "", api_key: "", models: [],
    }, null, 2), "utf-8");
    writeFileSync(join(dir, "vision.json"), JSON.stringify(provider.vision, null, 2), "utf-8");
    return provider;
  }

  saveConfig(uuidId: string, cfg: { name: string; base_url: string; api_key: string; models: string[] }) {
    const dir = join(this.providersDir, uuidId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ uuidId, ...cfg }, null, 2), "utf-8");
  }

  saveVision(uuidId: string, vision: any) {
    const dir = join(this.providersDir, uuidId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "vision.json"), JSON.stringify(vision, null, 2), "utf-8");
  }

  remove(uuidId: string): boolean {
    const dir = join(this.providersDir, uuidId);
    if (!existsSync(dir)) return false;
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch { return false; }
  }
}

function migrateFromLegacySettings(providersDir: string): void {
  if (!existsSync(providersDir)) return;
  const existingDirs = readdirSync(providersDir).filter(d =>
    existsSync(join(providersDir, d, "config.json"))
  );
  if (existingDirs.length > 0) return; // already migrated

  const settingsPath = join(CONFIG_DIR, "settings.json");
  if (!existsSync(settingsPath)) return;
  try {
    const old = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!Array.isArray(old.providers) || old.providers.length === 0) return;
    console.log(`[OhMyCodex] Migrating ${old.providers.length} providers to per-provider dirs...`);
    for (const p of old.providers) {
      const uuidId = p.id || crypto.randomUUID();
      const dir = join(providersDir, uuidId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.json"), JSON.stringify({
        uuidId,
        name: p.name || "Untitled",
        base_url: p.base_url || "",
        api_key: p.api_key || "",
        models: p.models || [],
      }, null, 2), "utf-8");
      writeFileSync(join(dir, "vision.json"), JSON.stringify(
        p.vision || { mode: "default", model: p.vision_model || "", base_url: "", api_key: "" },
        null, 2
      ), "utf-8");
    }
    // Update settings.json to only keep global state
    const newSettings: any = { log_level: old.log_level || "info" };
    if (old.active_provider_id) newSettings.active_provider_uuidId = old.active_provider_id;
    writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2), "utf-8");
    console.log(`[OhMyCodex] Migration complete. settings.json updated.`);
  } catch (err: any) {
    console.error(`[OhMyCodex] Migration error: ${err.message}`);
  }
}
migrateFromLegacySettings(PROVIDERS_DIR);

let currentLogLevel: LogLevel = "info";
export function setLogLevel(level: LogLevel) {
  currentLogLevel = level;
  addLog("CONFIG", `日志级别已调整为 ${level.toUpperCase()}`, "info", true);
}
export function getLogLevel(): LogLevel { return currentLogLevel; }

function logFilePath(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return join(LOGS_DIR, `ohmycodex-${y}${m}${day}.log`);
}

function writeFileLog(payload: { time: string; tag: string; text: string; level: string }) {
  try {
    const line = `${payload.time} [${payload.level.toUpperCase()}] [${payload.tag}] ${payload.text}\n`;
    appendFileSync(logFilePath(), line, "utf-8");
  } catch { /* ignore */ }
}

// In-Memory Live Logs Buffer & SSE broadcaster
const activeSseClients = new Set<(payload: any) => void>();
export const logBuffer: any[] = [];
const MAX_LOG_BUFFER = 500;

// IPC log event emitter — for Electron renderer log forwarding
export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(20);

export function addLog(tag: string, text: string, level: string = "info", force = false) {
  const lvl = (LEVEL_RANK[level as LogLevel] !== undefined ? level : "info") as LogLevel;
  if (!force && LEVEL_RANK[lvl] < LEVEL_RANK[currentLogLevel]) return;

  const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const payload = { time: timeStr, tag, text, level: lvl };
  logBuffer.push(payload);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();

  writeFileLog(payload);

  for (const send of activeSseClients) {
    try { send(payload); } catch { /* ignore */ }
  }
  logEmitter.emit("log", payload);
}

// Intercept all system logs so they stream seamlessly to the Web Dashboard!
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args: any[]) => {
  originalLog(...args);
  const txt = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  addLog("INFO", txt, "info");
};

console.error = (...args: any[]) => {
  originalError(...args);
  const txt = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  addLog("ERROR", txt, "error");
};

console.warn = (...args: any[]) => {
  originalWarn(...args);
  const txt = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  addLog("WARN", txt, "warn");
};

export class ProxyServer {
  private server: http.Server | null = null;
  private config!: ProxyConfig;
  private configDir = CONFIG_DIR;
  private pm: ProviderManager;

  constructor() {
    this.pm = new ProviderManager();
    this.ensureConfigDir();
    this.loadConfig();
    this.autoPatchCodexConfig();
  }

  private ensureConfigDir() {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }

  private settingsPath(): string { return join(this.configDir, "settings.json"); }

  private loadConfig() {
    const p = this.settingsPath();
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8"));
        this.config = {
          active_provider_uuidId: raw.active_provider_uuidId || raw.active_provider_id || "",
          log_level: raw.log_level,
        };
        if (this.config.log_level && LEVEL_RANK[this.config.log_level]) {
          currentLogLevel = this.config.log_level;
        }
        // Ensure at least one provider exists
        const all = this.pm.list();
        if (all.length === 0) {
          this.pm.create("Default");
          console.log(`[OhMyCodex] No providers found. Created default provider.`);
        }
        // Validate active_provider_uuidId points to an existing provider
        const validIds = new Set(this.pm.list().map(p => p.uuidId));
        if (!this.config.active_provider_uuidId || !validIds.has(this.config.active_provider_uuidId)) {
          this.config.active_provider_uuidId = this.pm.list()[0]?.uuidId || "";
          this.saveConfig();
        }
        console.log(`[OhMyCodex] Loaded settings: ${p} (log_level=${currentLogLevel}, ${this.pm.list().length} providers)`);
        return;
      } catch (err: any) {
        console.error(`[OhMyCodex] Error reading settings.json: ${err.message}`);
      }
    }

    this.config = { log_level: "info" };
    this.pm.create("Default");
    this.config.active_provider_uuidId = this.pm.list()[0]?.uuidId || "";
    console.log(`[OhMyCodex] Config file not found. Created default settings.`);
    this.saveConfig();
  }

  private saveConfig() {
    const p = this.settingsPath();
    try {
      this.config.log_level = currentLogLevel;
      writeFileSync(p, JSON.stringify(this.config, null, 2), "utf-8");
    } catch (err: any) {
      console.error(`[OhMyCodex] Failed to save settings: ${err.message}`);
    }
  }

  private ensureModelCatalog() {
    const p = join(this.configDir, "custom_model_catalog.json");
    if (!existsSync(p)) {
      const defaultCatalog = this.buildCatalogFromModelNames([DEFAULT_MODEL]);
      writeFileSync(p, JSON.stringify(defaultCatalog, null, 2), "utf-8");
      console.log(`[OhMyCodex] Created default model catalog at ${p}`);
      return;
    }

    try {
      const catalog = JSON.parse(readFileSync(p, "utf-8"));
      if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
        const defaultCatalog = this.buildCatalogFromModelNames([DEFAULT_MODEL]);
        writeFileSync(p, JSON.stringify(defaultCatalog, null, 2), "utf-8");
        console.log(`[OhMyCodex] Seeded default model catalog with ${DEFAULT_MODEL}.`);
      }
    } catch (err: any) {
      console.error(`[OhMyCodex] Failed to validate model catalog: ${err.message}`);
    }
  }

  private getModelCatalog(): any {
    const p = join(this.configDir, "custom_model_catalog.json");
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8"));
      } catch (err: any) {
        console.error(`[OhMyCodex] Failed to read model catalog: ${err.message}`);
      }
    }
    return { models: [] };
  }

  private saveModelCatalog(catalog: any) {
    const p = join(this.configDir, "custom_model_catalog.json");
    try {
      const jsonStr = JSON.stringify(catalog, null, 2);
      writeFileSync(p, jsonStr, "utf-8");
      console.log(`[OhMyCodex] Saved custom model catalog to ${p}`);
    } catch (err: any) {
      console.error(`[OhMyCodex] Failed to save custom model catalog: ${err.message}`);
    }
  }

  private buildCatalogFromModelNames(names: string[]): any {
    const uniqueNames = [...new Set(names.map((name) => String(name).trim()).filter(Boolean))];
    return {
      models: uniqueNames.map((name) => ({
        slug: name,
        model: name,
        display_name: name,
        description: `Custom model: ${name}`,
        context_window: 200000,
        max_context_window: 200000,
        auto_compact_token_limit: 160000,
        truncation_policy: { mode: "tokens", limit: 64000 },
        default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "medium", description: "Balanced" }, { effort: "high", description: "Thorough" }, { effort: "xhigh", description: "Maximum" }],
        default_reasoning_summary: "none",
        reasoning_summary_format: "none",
        supports_reasoning_summaries: false,
        default_verbosity: "low",
        support_verbosity: false,
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text_and_image",
        supports_search_tool: false,
        supports_parallel_tool_calls: true,
        experimental_supported_tools: ["computer_use", "mcp"],
        input_modalities: ["text", "image"],
        supports_image_detail_original: true,
        shell_type: "shell_command",
        visibility: "list",
        minimal_client_version: "0.0.1",
        supported_in_api: true,
        availability_nux: null,
        upgrade: null,
        priority: 100,
        prefer_websockets: false,
        available_in_plans: ["free", "plus", "pro", "team", "business", "enterprise"],
        base_instructions: "You are a coding agent running in Codex through a local BYOK shim.",
        model_messages: {
          instructions_template: "You are Codex running on {model_name} through a local all-model shim. Be a helpful, direct coding collaborator.",
          instructions_variables: { model_name: name }
        },
        supports_computer_use: true,
        supports_mcp: true,
        vision_bridge_enabled: false
      }))
    };
  }

  private getPrimaryModelName(): string {
    const catalog = this.getModelCatalog();
    const visible = catalog.models?.find((m: any) => m.visibility === "list");
    const first = visible || catalog.models?.[0];
    return first?.slug || first?.model || DEFAULT_MODEL;
  }

  private findProvider(model: string): ProviderConfig | null {
    const all = this.pm.list();
    if (all.length === 0) return null;

    // Active provider gets priority
    const active = all.find(p => p.uuidId === this.config.active_provider_uuidId);
    if (active) return active;

    // Fallback to first provider
    return all[0] || null;
  }

  private resolveKey(raw: string): string {
    if (raw.startsWith("$")) {
      return process.env[raw.slice(1)] || "";
    }
    return raw;
  }

  private autoPatchCodexConfig() {
    const tomlPath = join(homedir(), ".codex", "config.toml");

    this.ensureModelCatalog();

    const catalogPath = join(this.configDir, "custom_model_catalog.json");

    if (!existsSync(tomlPath)) {
      console.warn(`[OhMyCodex] Codex config.toml not found at ${tomlPath}. Skipped auto-patching.`);
      return;
    }

    try {
      const tomlContent = readFileSync(tomlPath, "utf-8");

      if (tomlContent.includes("# >>> ohmycodex managed >>>") || tomlContent.includes("# >>> opencodex managed >>>")) {
        return;
      }

      console.log(`[OhMyCodex] Detecting unpatched config.toml. Performing surgical auto-patch...`);

      const tomlBackupPath = tomlPath + ".bak_" + Date.now();
      writeFileSync(tomlBackupPath, tomlContent, "utf-8");
      console.log(`[OhMyCodex] Created backup of config.toml at ${tomlBackupPath}`);

      let patchedToml = stripManagedBlocks(tomlContent);

      const managedTop = `# >>> ohmycodex managed >>>
model = "${this.getPrimaryModelName()}"
model_provider = "ohmycodex"
model_catalog_json = "${catalogPath}"
model_reasoning_effort = "high"
# <<< ohmycodex managed <<<
`;

      const managedProvider = `# >>> ohmycodex managed >>>
[model_providers.ohmycodex]
name = "OhMyCodex"
base_url = "http://localhost:16868/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "dummy"
request_max_retries = 3
stream_max_retries = 3
stream_idle_timeout_ms = 600000
# <<< ohmycodex managed <<<
`;

      patchedToml = managedTop + "\n" + patchedToml + "\n\n" + managedProvider;
      writeFileSync(tomlPath, patchedToml, "utf-8");
      console.log(`[OhMyCodex] Successfully patched config.toml to route via OhMyCodex!`);

      this.restartCodexDesktop();
    } catch (err: any) {
      console.error(`[OhMyCodex] Failed to auto-patch config.toml: ${err.message}`);
    }
  }

  public patchCodexConfig() {
    const tomlPath = join(homedir(), ".codex", "config.toml");
    const catalogPath = join(this.configDir, "custom_model_catalog.json");
    if (!existsSync(tomlPath)) return;
    try {
      const content = readFileSync(tomlPath, "utf-8");
      let patched = stripManagedBlocks(content);
      const managedTop = `# >>> ohmycodex managed >>>
model = "${this.getPrimaryModelName()}"
model_provider = "ohmycodex"
model_catalog_json = "${catalogPath}"
model_reasoning_effort = "high"
# <<< ohmycodex managed <<<
`;
      const managedProvider = `# >>> ohmycodex managed >>>
[model_providers.ohmycodex]
name = "OhMyCodex"
base_url = "http://localhost:16868/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "dummy"
request_max_retries = 3
stream_max_retries = 3
stream_idle_timeout_ms = 600000
# <<< ohmycodex managed <<<
`;
      patched = managedTop + "\n" + patched + "\n\n" + managedProvider;
      writeFileSync(tomlPath, patched, "utf-8");
      console.log(`[OhMyCodex] Patched config.toml with ohmycodex provider.`);
    } catch (err: any) {
      console.error(`[OhMyCodex] Failed to patch config.toml: ${err.message}`);
    }
  }

  public restartCodexDesktop() {
    console.log("[OhMyCodex] Executing background cold-restart of Codex Desktop...");
    const isWin = process.platform === "win32";
    if (isWin) {
      const cmd = 'taskkill /F /IM Codex.exe /T 2>nul & timeout /T 2 /nobreak >nul & start "" "%LOCALAPPDATA%\\Programs\\Codex\\Codex.exe"';
      exec(cmd, (err) => {
        if (err) console.error(`[OhMyCodex] Codex restart error: ${err.message}`);
        else console.log("[OhMyCodex] Codex Desktop restarted (Windows).");
      });
    } else {
      const cmd = "killall Codex \"Codex Helper\" \"Codex Helper (Renderer)\" \"Codex Helper (GPU)\" SkyComputerUseClient SkyComputerUseService bare-modifier-monitor 2>/dev/null; " +
        "kill -9 $(ps aux | grep -i \"codex app-server\" | grep -v \"grep\" | awk '{print $2}') 2>/dev/null; sleep 1.5; open -a Codex";
      exec(cmd, (err) => {
        if (err) console.error(`[OhMyCodex] Codex restart error: ${err.message}`);
        else console.log("[OhMyCodex] Codex Desktop restarted (macOS).");
      });
    }
  }

  start(port: number) {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => this.handle(req, res, body));
    });
    // Disable per-request idle timeout — SSE streams need to live forever
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.listen(port, "0.0.0.0");
    console.log(`[OhMyCodex] Unified HTTP server listening on port ${port}`);
    console.log(`[OhMyCodex] Web Dashboard UI → http://localhost:${port}/dashboard`);

    // Heartbeat — emits an INFO line every 60s so live cockpit visibly proves it's alive
    setInterval(() => {
      addLog("HEARTBEAT", `gateway alive · clients=${activeSseClients.size}`, "info");
    }, 60000);
    // Finer-grained debug heartbeat every 15s for users on debug level
    setInterval(() => {
      addLog("HEARTBEAT", `tick · buffer=${logBuffer.length}`, "debug");
    }, 15000);
  }

  stop() {
    this.server?.close();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, session_id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Debug request trace — visible only when level=debug
    try {
      const pathOnly = (req.url || "/").split("?")[0];
      if (pathOnly !== "/api/logs/stream" && pathOnly !== "/api/logs/since") {
        addLog("REQ", `${req.method} ${pathOnly}`, "debug");
      }
    } catch { /* ignore */ }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    // ─── Web Dashboard Routes ───
    if (path === "/dashboard" || path === "/dashboard/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(getDashboardHtml());
      return;
    }

    if (path === "/api/logs/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      // Disable socket idle timeout so the stream stays open across long idle gaps
      try {
        req.socket.setKeepAlive(true);
        req.socket.setNoDelay(true);
        req.socket.setTimeout(0);
        (res as any).flushHeaders?.();
      } catch { /* ignore */ }

      // Send initial backlog
      for (const line of logBuffer) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
      // Initial comment so client confirms stream
      res.write(`: connected ${Date.now()}\n\n`);

      const sender = (payload: any) => {
        try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* ignore */ }
      };

      activeSseClients.add(sender);

      // Keep-alive comment ping every 15s — prevents intermediaries from closing the stream
      const keepAlive = setInterval(() => {
        try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* ignore */ }
      }, 15000);

      req.on("close", () => {
        clearInterval(keepAlive);
        activeSseClients.delete(sender);
      });
      return;
    }

    if (path === "/api/config" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        // Legacy endpoint — save to active provider instead of overwriting all
        const activeUuidId = this.config.active_provider_uuidId;
        if (activeUuidId) {
          const modelNames = Array.isArray(data.models) ? data.models : [];
          this.pm.saveConfig(activeUuidId, {
            name: data.primary?.name || "custom",
            base_url: data.primary?.base_url || "",
            api_key: data.primary?.api_key || "",
            models: modelNames,
          });
          if (data.ohmycodex) {
            // Preserve existing vision mode — the /api/providers endpoint is
            // the source of truth for mode.  The legacy /api/config endpoint
            // must NOT blindly overwrite it to "custom".
            const _existingVision = this.pm.load(activeUuidId)?.vision;
            const _preservedMode = _existingVision?.mode || "default";
            this.pm.saveVision(activeUuidId, {
              mode: _preservedMode,
              model: data.ohmycodex.model || _existingVision?.model || "",
              base_url: data.ohmycodex.base_url || _existingVision?.base_url || "",
              api_key: (data.ohmycodex.api_key && data.ohmycodex.api_key !== "" && data.ohmycodex.api_key !== "MASKED")
                ? data.ohmycodex.api_key : (_existingVision?.api_key || ""),
            });
          }
        }

        const modelNames = Array.isArray(data.models) ? data.models : [];
        if (modelNames.length > 0) {
          const catalog = this.buildCatalogFromModelNames(modelNames);
          this.saveModelCatalog(catalog);
        }

        this.patchCodexConfig();
        if (data.restart) this.restartCodexDesktop();
        res.writeHead(200, { "Content-Type": "application/json" });
        addLog("CONFIG", "API 配置已保存" + (data.restart ? "，正在重启 Codex..." : ""), "info");
        res.end(JSON.stringify({ status: "success", restarted: !!data.restart }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/models" && req.method === "GET") {
      // Returns complete model catalog & enabled models
      const catalog = this.getModelCatalog();
      const active = catalog.models?.filter((m: any) => m.visibility === "list").map((m: any) => m.slug) || [];
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        catalog: catalog.models?.map((m: any) => ({
          id: m.slug,
          model: m.model,
          display_name: m.display_name,
          no_image_support: m.input_modalities ? !m.input_modalities.includes("image") : true,
          vision_bridge_enabled: !!m.vision_bridge_enabled
        })) || [],
        active
      }));
      return;
    }

    if (path === "/api/models" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const activeIds = data.active || [];
        const catalog = this.getModelCatalog();
        
        if (catalog.models) {
          catalog.models.forEach((m: any) => {
            m.visibility = activeIds.includes(m.slug) ? "list" : "hide";
          });
          this.saveModelCatalog(catalog);
        }
        
        if (data.restart) {
          this.restartCodexDesktop();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        addLog("CONFIG", "API 配置已保存" + (data.restart ? "，正在重启 Codex..." : ""), "info");
        res.end(JSON.stringify({ status: "success", restarted: !!data.restart }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/models/delete" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const slug = data.id;
        const catalog = this.getModelCatalog();
        if (catalog.models) {
          catalog.models = catalog.models.filter((m: any) => m.slug !== slug && m.model !== slug);
          this.saveModelCatalog(catalog);
          console.log(`[OhMyCodex] Deleted model: ${slug}`);
        addLog("CONFIG", `已删除模型: ${slug}`, "info");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/restart-codex" && req.method === "POST") {
      try {
        this.restartCodexDesktop();
        addLog("CONFIG", "正在重启 Codex Desktop...", "info");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/reset" && req.method === "POST") {
      try {
        const tomlPath = join(homedir(), ".codex", "config.toml");
        if (existsSync(tomlPath)) {
          let content = readFileSync(tomlPath, "utf-8");
          content = stripManagedBlocks(content);
          writeFileSync(tomlPath, content + "\n", "utf-8");
        }
        const catalogPath = join(this.configDir, "custom_model_catalog.json");
        if (existsSync(catalogPath)) {
          writeFileSync(catalogPath, JSON.stringify({ models: [] }), "utf-8");
        }
        console.log("[OhMyCodex] Reset to native state. Restarting Codex...");
        addLog("CONFIG", "正在还原原生 Codex 配置...", "info");
        this.restartCodexDesktop();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/fetch-models" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const base = (data.base_url || "").trim().replace(/\/+$/, "");
        const key = (data.api_key || "").trim();
        if (!base) throw new Error("Base URL 不能为空");
        if (!key) throw new Error("API Key 不能为空");

        let url = base.replace(/\/v\d+$/i, "");
        url = `${url}/v1/models`;

        console.log(`[OhMyCodex] Fetching models from: ${url}`);
        addLog("CONFIG", `正在从 ${base} 获取模型列表...`, "info");

        const transport = url.startsWith("https") ? https : http;

        const result = await new Promise<{ models: string[]; error?: string }>((resolve) => {
          const request = transport.get(url, {
            headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
            timeout: 10000,
          }, (resp: any) => {
            let d = "";
            resp.on("data", (c: any) => d += c);
            resp.on("end", () => {
              try {
                const json = JSON.parse(d);
                if (json.error) {
                  const errMsg = json.error.message || "API error";
                  console.error(`[OhMyCodex] Fetch models failed: ${errMsg}`);
                  addLog("CONFIG", `获取模型失败: ${errMsg}`, "warn");
                  resolve({ models: [], error: errMsg });
                  return;
                }
                const list = (json.data || json.models || [])
                  .map((m: any) => m.id || m.model || "")
                  .filter(Boolean)
                  .sort();
                console.log(`[OhMyCodex] Fetched ${list.length} models from provider`);
                addLog("CONFIG", `成功获取 ${list.length} 个模型`, "info");
                resolve({ models: list });
              } catch {
                addLog("CONFIG", "获取模型失败: 响应格式异常", "warn");
                resolve({ models: [], error: "响应格式异常" });
              }
            });
          });
          request.on("error", (e: any) => {
            addLog("CONFIG", `获取模型失败: ${e.message}`, "warn");
            resolve({ models: [], error: e.message });
          });
          request.on("timeout", () => {
            request.destroy();
            addLog("CONFIG", "获取模型失败: 请求超时", "warn");
            resolve({ models: [], error: "请求超时" });
          });
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        addLog("CONFIG", `获取模型异常: ${err.message}`, "warn");
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    // ─── Standard Gateway Routes ───

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "1.0.0", ohmycodex: true }));
      return;
    }

    if (path === "/api/log-level" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ level: getLogLevel(), levels: ["debug", "info", "warn", "error"] }));
      return;
    }

    if (path === "/api/logs/since") {
      const sinceIndex = parseInt(url.searchParams.get("index") || "0", 10);
      const allLogs = logBuffer;
      const newLogs = sinceIndex < allLogs.length ? allLogs.slice(sinceIndex) : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ logs: newLogs, nextIndex: allLogs.length }));
      return;
    }

    if (path === "/api/log-level" && req.method === "POST") {
      try {
        const data = JSON.parse(body || "{}");
        const lvl = (data.level || "info").toLowerCase();
        if (!["debug", "info", "warn", "error"].includes(lvl)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid level" }));
          return;
        }
        setLogLevel(lvl as LogLevel);
        this.saveConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", level: getLogLevel() }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/v1/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...this.config,
        providers: this.pm.list(),
      }, null, 2));
      return;
    }

    if (path === "/v1/models" || path === "/v1/models/") {
      const catalog = this.getModelCatalog();
      const list = catalog.models || [];
      
      // Filter list based on visibility === "list"
      const data = list
        .filter((m: any) => m.visibility === "list")
        .map((m: any) => ({
          id: m.slug,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "ohmycodex"
        }));

      // Always inject native Computer Use pass-through model id
      data.push({ id: "ohmycodex/cu", object: "model", owned_by: "local" });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
      return;
    }


    // Provider CRUD API

    if (path === "/api/providers" && req.method === "GET") {
      const all = this.pm.list();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        active_uuidId: this.config.active_provider_uuidId || (all[0]?.uuidId || ""),
        providers: all.map(p => ({
          uuidId: p.uuidId,
          name: p.name,
          base_url: p.base_url,
          api_key: p.api_key || "",
          models: p.models || [],
          vision: p.vision || { mode: "default", model: "", base_url: "", api_key: "" },
        }))
      }));
      return;
    }

    if (path === "/api/providers" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        let uuidId = data.uuidId || data.id || "";

        if (uuidId && this.pm.load(uuidId)) {
          // Update existing — preserve api_key if not explicitly sent
          const existing = this.pm.load(uuidId)!;
          const newApiKey = (data.api_key !== undefined && data.api_key !== "" && data.api_key !== "MASKED")
            ? data.api_key
            : existing.api_key;
          this.pm.saveConfig(uuidId, {
            name: data.name || existing.name,
            base_url: data.base_url !== undefined ? data.base_url : existing.base_url,
            api_key: newApiKey,
            models: Array.isArray(data.models) ? data.models : (existing.models || []),
          });
          // Always save vision config to preserve mode selection
          if (data.vision) {
            const ev = existing.vision || { mode: "default", model: "", base_url: "", api_key: "" };
            this.pm.saveVision(uuidId, {
              mode: data.vision.mode || ev.mode,
              model: data.vision.model || ev.model,
              base_url: data.vision.base_url !== undefined ? data.vision.base_url : ev.base_url,
              api_key: (data.vision.api_key !== undefined && data.vision.api_key !== "" && data.vision.api_key !== "MASKED")
                ? data.vision.api_key : ev.api_key,
            });
          }
        } else {
          // Create new provider
          const created = this.pm.create(data.name || "New Provider");
          uuidId = created.uuidId;
          this.pm.saveConfig(uuidId, {
            name: data.name || "New Provider",
            base_url: data.base_url || "",
            api_key: data.api_key || "",
            models: Array.isArray(data.models) ? data.models : [],
          });
          if (data.vision) {
            this.pm.saveVision(uuidId, data.vision);
          }
        }
        addLog("CONFIG", "Provider " + (data.name || uuidId) + " saved (" + uuidId + ")", "info");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", uuidId }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/providers/active" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const targetId = data.uuidId || data.id;
        if (targetId && this.pm.load(targetId)) {
          this.config.active_provider_uuidId = targetId;
          this.saveConfig();
          addLog("CONFIG", "Active provider set to " + targetId, "info");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path.startsWith("/api/providers/") && req.method === "DELETE") {
      const providerUuidId = path.split("/api/providers/")[1];
      addLog("CONFIG", `DELETE request for provider: ${providerUuidId}`, "info");
      const existing = providerUuidId ? this.pm.load(providerUuidId) : null;
      if (providerUuidId && existing) {
        const removed = this.pm.remove(providerUuidId);
        addLog("CONFIG", `Remove result for ${providerUuidId}: ${removed}`, "info");
        if (this.config.active_provider_uuidId === providerUuidId) {
          const remaining = this.pm.list();
          this.config.active_provider_uuidId = remaining[0]?.uuidId || "";
          this.saveConfig();
        }
        addLog("CONFIG", "Deleted provider " + providerUuidId, "info");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } else {
        addLog("CONFIG", `Provider not found: ${providerUuidId} (existing=${!!existing})`, "warn");
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Provider not found", uuidId: providerUuidId }));
      }
      return;
    }

    if (path === "/api/providers/fetch-models" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const base = (data.base_url || "").trim().replace(/\/+$/, "");
        const key = (data.api_key || "").trim();
        if (!base) throw new Error("Base URL required");
        if (!key) throw new Error("API Key required");

        let url = base.replace(/\/v\d+$/i, "");
        url = url + "/v1/models";
        addLog("CONFIG", "Fetching models from " + base + "...", "info");

        const transport = url.startsWith("https") ? https : http;
        const result = await new Promise<{ models: string[]; error?: string }>((resolve) => {
          const request = transport.get(url, {
            headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
            timeout: 10000,
          }, (resp: any) => {
            let d = "";
            resp.on("data", (c: any) => d += c);
            resp.on("end", () => {
              try {
                const json = JSON.parse(d);
                if (json.error) { resolve({ models: [], error: json.error.message || "API error" }); return; }
                const list = (json.data || json.models || []).map((m: any) => m.id || m.model || "").filter(Boolean).sort();
                addLog("CONFIG", "Fetched " + list.length + " models", "info");
                resolve({ models: list });
              } catch { resolve({ models: [], error: "Invalid response" }); }
            });
          });
          request.on("error", (e: any) => resolve({ models: [], error: e.message }));
          request.on("timeout", () => { request.destroy(); resolve({ models: [], error: "Timeout" }); });
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }


    if (path === "/v1/responses" && req.method === "POST") {
      this.handleResponses(body, res);
      return;
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      this.handleChat(body, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint not found" }));
  }

  // ══════════════════════════════════════════════
  //  Responses API Gateway (Used by Codex UI)
  // ══════════════════════════════════════════════

  private async handleResponses(body: string, res: http.ServerResponse) {
    let reqBody: any;
    try {
      reqBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const requestedModel = reqBody.model || "";
    
    // Resolve which actual model and provider we route to
    const catalog = this.getModelCatalog();
    const catalogEntry = catalog.models?.find((m: any) => m.slug === requestedModel);
    const mappedModelName = (catalogEntry && catalogEntry.model) ? catalogEntry.model : requestedModel;

    const provider = this.findProvider(mappedModelName);
    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown model: ${requestedModel}` }));
      return;
    }

    const apiKey = this.resolveKey(provider.api_key);
    if (!apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `API Key is missing. Configure keys via http://localhost:16868/dashboard` }));
      return;
    }

    // Always compress images; describe with MiMo if vision bridge enabled
    const callVisionBridge = catalogEntry ? !!catalogEntry.vision_bridge_enabled : false;
    const visionConfig = callVisionBridge ? { vision_config: provider.vision || {} } : undefined;
    const processedReqBody = await processVisionBridge(reqBody, visionConfig);

    const upstreamModel = mappedModelName;
    const isStream = processedReqBody.stream ?? false;

    console.log(`[Responses] Routing ${requestedModel} → ${provider.name}/${upstreamModel} (stream=${isStream}, visionBridge=${callVisionBridge})`);

    const chatBody = responsesToChat(processedReqBody, upstreamModel);
    const namespaceMap = extractNamespaceMap(processedReqBody.tools);

    try {
      if (isStream) {
        await this.streamResponses(chatBody, provider, requestedModel, apiKey, namespaceMap, res);
      } else {
        await this.nonStreamResponses(chatBody, provider, requestedModel, apiKey, namespaceMap, res);
      }
    } catch (err: any) {
      console.error(`[Responses] Error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  private async streamResponses(
    body: any,
    provider: ProviderConfig,
    requestedModel: string,
    apiKey: string,
    namespaceMap: Record<string, string>,
    res: http.ServerResponse
  ) {
    const response = await fetch(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errorText }));
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.writeHead(200);

    const streamState = new ResponsesStreamState(requestedModel, namespaceMap);
    await streamState.start(async (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const chunk = JSON.parse(trimmed.slice(6));
            await streamState.writeChatDelta(async (payload) => {
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
            }, chunk);
          } catch {
            // ignore JSON parsing chunks error
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    await streamState.finish(async (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
    res.end();
  }

  private async nonStreamResponses(
    body: any,
    provider: ProviderConfig,
    requestedModel: string,
    apiKey: string,
    namespaceMap: Record<string, string>,
    res: http.ServerResponse
  ) {
    const r = await fetch(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });

    const rawText = await r.text();
    let data: any;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { error: rawText.slice(0, 250) };
    }

    if (!r.ok) {
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    const responseBody = chatCompletionToResponse(data, requestedModel, namespaceMap);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responseBody));
  }

  // ══════════════════════════════════════════════
  //  Standard OpenAI Chat completions routing
  // ══════════════════════════════════════════════

  private async handleChat(body: string, res: http.ServerResponse) {
    const reqBody = JSON.parse(body);
    const model = reqBody.model || "";
    const provider = this.findProvider(model);
    
    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown model: ${model}` }));
      return;
    }

    const apiKey = this.resolveKey(provider.api_key);
    if (!apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `API Key missing.` }));
      return;
    }

    const upstreamModel = model;
    const isStream = reqBody.stream ?? false;
    
    console.log(`[Chat] Routing ${model} → ${provider.name}/${upstreamModel} (stream=${isStream})`);

    const upstreamBody = {
      model: upstreamModel,
      messages: this.translateMessages(reqBody.messages || [], model),
      temperature: reqBody.temperature ?? 0.7,
      max_tokens: reqBody.max_output_tokens ?? 8192,
      stream: isStream
    };

    try {
      if (isStream) {
        await this.streamChat(upstreamBody, provider, model, apiKey, res);
      } else {
        await this.nonStreamChat(upstreamBody, provider, model, apiKey, res);
      }
    } catch (err: any) {
      console.error(`[Chat] Error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  private translateMessages(messages: any[], model: string): any[] {
    const hasNativeVision = ["mimo-v2.5", "mimo-v2-omni"].includes(model);

    return messages.map((msg: any) => {
      if (msg.role === "tool") {
        return {
          role: "tool",
          tool_call_id: msg.tool_call_id || "",
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
        };
      }

      if (msg.role === "assistant" && msg.tool_calls) {
        return {
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.tool_calls.map((tc: any) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.function?.name || tc.name || "",
              arguments: tc.function?.arguments
                ? typeof tc.function.arguments === "string"
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments)
                : "{}"
            }
          }))
        };
      }

      if (!Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: msg.content.map((part: any) => {
          if (part.type === "image_url" || part.type === "image") {
            if (hasNativeVision) {
              return { type: "image_url", image_url: { url: part.image_url?.url || part.source?.url || "" } };
            }
            return { type: "text", text: "[Visual Screenshot description omitted by OhMyCodex]" };
          }
          return part;
        })
      };
    });
  }

  private async nonStreamChat(body: any, provider: ProviderConfig, model: string, apiKey: string, res: http.ServerResponse) {
    const r = await fetch(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    
    const text = await r.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
    
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private async streamChat(body: any, provider: ProviderConfig, model: string, apiKey: string, res: http.ServerResponse) {
    const r = await fetch(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errorText = await r.text();
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errorText }));
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.writeHead(200);

    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;
          try {
            res.write(`data: ${trimmed.slice(6)}\n\n`);
          } catch {
            // ignore
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function stripManagedBlocks(content: string): string {
  return content
    .replace(/# >>> opencodex managed >>>[\s\S]*?# <<< opencodex managed <<<\n?/gi, "")
    .replace(/# >>> ohmycodex managed >>>[\s\S]*?# <<< ohmycodex managed <<<\n?/gi, "")
    .trim();
}

function getDefaultCatalog() {
  return { models: [] };
}
