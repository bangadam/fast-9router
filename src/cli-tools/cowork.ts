// Claude Cowork settings: Claude-3p configLibrary profile + 1p bootstrap.
// Ported from 9router cowork-settings route. Local SSE MCP bridges and the
// machine-bound CLI token require the legacy app's /api/mcp endpoints; here
// the bridge URL points at this gateway's port and the token is derived from
// the same salted-machine-id scheme.

import { join } from "node:path";
import { homedir, platform } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { fileExists, readJsonWithDeps, readText, writeJsonFile, type ToolDeps } from "./core.ts";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";
const APP_PORT = 20129;
const LOCAL_MCP_PREFIX = `http://localhost:${APP_PORT}/api/mcp/`;

export const COWORK_DEFAULT_PLUGINS = [
  {
    name: "exa",
    title: "Exa",
    description: "Real-time web search and code documentation",
    url: "https://mcp.exa.ai/mcp",
    transport: "http",
    oauth: false,
    toolNames: ["web_search_exa", "web_fetch_exa"],
  },
  {
    name: "tavily",
    title: "Tavily",
    description: "Real-time web search optimized for LLM agents",
    url: "https://mcp.tavily.com/mcp",
    transport: "http",
    oauth: true,
    toolNames: ["tavily_search", "tavily_extract", "tavily_crawl", "tavily_map"],
  },
] as const;

export const COWORK_LOCAL_STDIO_PLUGINS = [
  {
    name: "browsermcp",
    title: "Browser MCP",
    description: "Control your running Chrome (requires Chrome extension)",
    command: "npx",
    args: ["-y", "@browsermcp/mcp@latest"],
    toolNames: ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_screenshot", "browser_get_console_logs", "browser_wait", "browser_press_key", "browser_go_back", "browser_go_forward"],
  },
] as const;

const SECURITY_RELAX = {
  coworkEgressAllowedHosts: ["*"],
  disabledBuiltinTools: [],
  isLocalDevMcpEnabled: true,
  isDesktopExtensionEnabled: true,
  isDesktopExtensionDirectoryEnabled: true,
  isDesktopExtensionSignatureRequired: false,
  isClaudeCodeForDesktopEnabled: true,
  disableEssentialTelemetry: true,
  disableNonessentialTelemetry: true,
  disableNonessentialServices: true,
};

type CoworkPlugin = { name: string; url: string; transport?: string; oauth?: boolean; toolNames?: string[] };

function buildManagedMcpServers(plugins: CoworkPlugin[]) {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const p of plugins) {
    if (!p?.name || !p.url || seen.has(p.name)) continue;
    seen.add(p.name);
    const entry: Record<string, unknown> = {
      name: p.name,
      url: p.url,
      transport: p.transport || (/\/sse(\b|\/)/i.test(p.url) ? "sse" : "http"),
    };
    if (p.oauth) entry.oauth = true;
    if (Array.isArray(p.toolNames) && p.toolNames.length > 0) {
      const prefix = `${p.name}-`;
      const bare = new Set<string>();
      for (const raw of p.toolNames) {
        if (typeof raw !== "string" || !raw) continue;
        let t = raw;
        while (t.startsWith(prefix)) t = t.slice(prefix.length);
        bare.add(t);
      }
      const policy: Record<string, string> = {};
      for (const t of bare) {
        policy[t] = "allow";
        policy[`${prefix}${t}`] = "allow";
      }
      entry.toolPolicy = policy;
    }
    out.push(entry);
  }
  return out;
}

function getCandidateRoots(): string[] {
  if (platform() === "darwin") {
    const base = join(homedir(), "Library", "Application Support");
    return [join(base, "Claude-3p"), join(base, "Claude")];
  }
  if (platform() === "win32") {
    const localApp = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return [join(localApp, "Claude-3p"), join(roaming, "Claude-3p"), join(localApp, "Claude"), join(roaming, "Claude")];
  }
  return [join(homedir(), ".config", "Claude-3p"), join(homedir(), ".config", "Claude")];
}

function getAppInstallPaths(): string[] {
  if (platform() === "darwin") {
    return ["/Applications/Claude.app", join(homedir(), "Applications", "Claude.app")];
  }
  if (platform() === "win32") {
    const localApp = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    return [join(localApp, "AnthropicClaude"), join(programFiles, "Claude"), join(programFiles, "AnthropicClaude")];
  }
  return [];
}

async function resolveAppRootForRead(): Promise<string> {
  for (const dir of getCandidateRoots()) {
    if (await fileExists(join(dir, "configLibrary"))) return dir;
  }
  return getCandidateRoots()[0]!;
}

const getWriteRoot = () => getCandidateRoots()[0]!;
const getWriteConfigDir = () => join(getWriteRoot(), "configLibrary");

function get1pRoot(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Claude");
  if (platform() === "win32") {
    const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(roaming, "Claude");
  }
  return join(homedir(), ".config", "Claude");
}

const get1pConfigPath = () => join(get1pRoot(), "claude_desktop_config.json");

async function read1pConfig(): Promise<Record<string, unknown>> {
  return (await readJsonWithDeps(get1pConfigPath(), {})) as Record<string, unknown> ?? {};
}

async function write1pConfig(cfg: Record<string, unknown>): Promise<void> {
  await mkdir(get1pRoot(), { recursive: true });
  await writeFile(get1pConfigPath(), JSON.stringify(cfg, null, 2));
}

async function bootstrapDeploymentMode(): Promise<boolean> {
  const cfg = await read1pConfig();
  if (cfg.deploymentMode === "3p") return false;
  cfg.deploymentMode = "3p";
  await write1pConfig(cfg);
  return true;
}

const COWORK_DEFAULT_PLUGINS_MUTABLE: CoworkPlugin[] = COWORK_DEFAULT_PLUGINS.map((p) => ({ ...p, toolNames: [...p.toolNames] }));
const COWORK_LOCAL_STDIO_PLUGINS_MUTABLE: Array<{ name: string; title: string; description: string; command: string; args: string[]; toolNames: string[] }> = COWORK_LOCAL_STDIO_PLUGINS.map((p) => ({ ...p, args: [...p.args], toolNames: [...p.toolNames] }));
async function cleanup1pLegacy(): Promise<void> {
  const cfg = await read1pConfig();
  const mcpServers = cfg.mcpServers as Record<string, unknown> | undefined;
  if (!mcpServers || typeof mcpServers !== "object") return;
  const managedNames = new Set(COWORK_LOCAL_STDIO_PLUGINS_MUTABLE.map((p) => p.name));
  for (const k of Object.keys(mcpServers)) {
    if (managedNames.has(k)) delete mcpServers[k];
  }
  if (Object.keys(mcpServers).length === 0) delete cfg.mcpServers;
  await write1pConfig(cfg);
}

function buildLocalBridgeEntries(localPluginNames: string[]) {
  const out: Array<Record<string, unknown>> = [];
  for (const n of localPluginNames) {
    const def = COWORK_LOCAL_STDIO_PLUGINS_MUTABLE.find((p) => p.name === n);
    if (!def) continue;
    const entry: Record<string, unknown> = {
      name: def.name,
      url: `http://localhost:${APP_PORT}/api/mcp/${def.name}/sse`,
      transport: "sse",
    };
    const policy: Record<string, string> = {};
    for (const t of def.toolNames) {
      policy[t] = "allow";
      policy[`${def.name}-${t}`] = "allow";
    }
    entry.toolPolicy = policy;
    out.push(entry);
  }
  return out;
}

function buildCustomEntries(customPlugins: Array<{ name?: string; url?: string; transport?: string }>) {
  const out: Array<Record<string, unknown>> = [];
  for (const p of customPlugins) {
    if (!p?.name || !p.url) continue;
    out.push({ name: p.name, url: p.url, transport: p.transport || "sse", custom: true });
  }
  return out;
}

async function getCliToken(): Promise<string> {
  const machineId = await (await import("node:os")).hostname();
  return createHash("sha256").update(`${CLI_TOKEN_SALT}:${machineId}`).digest("hex").slice(0, 16);
}

function injectAuthHeaders(entries: Array<Record<string, unknown>>, token: string) {
  for (const e of entries) {
    if (typeof e?.url === "string" && e.url.startsWith(LOCAL_MCP_PREFIX)) {
      e.headers = { ...((e.headers as Record<string, string>) ?? {}), [CLI_TOKEN_HEADER]: token };
    }
  }
  return entries;
}

async function ensureMeta(): Promise<{ appliedId: string; entries: Array<{ id: string; name: string }> }> {
  const writeMetaPath = join(getWriteConfigDir(), "_meta.json");
  let meta = (await readJsonWithDeps(writeMetaPath, {})) as { appliedId?: string; entries?: Array<{ id: string; name: string }> } | null;
  if (!meta || !meta.appliedId) {
    const readMetaPath = join(await resolveAppRootForRead(), "configLibrary", "_meta.json");
    const existingRead = (await readJsonWithDeps(readMetaPath, {})) as { appliedId?: string; entries?: Array<{ id: string; name: string }> } | null;
    if (existingRead?.appliedId) meta = existingRead;
    else {
      const newId = randomUUID();
      meta = { appliedId: newId, entries: [{ id: newId, name: "Default" }] };
    }
    await mkdir(getWriteConfigDir(), { recursive: true });
    await writeFile(writeMetaPath, JSON.stringify(meta, null, 2));
  }
  return meta as { appliedId: string; entries: Array<{ id: string; name: string }> };
}

async function writeSkipApprovals(managedServers: Array<Record<string, unknown>>) {
  const cfgPath = join(getWriteRoot(), "config.json");
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(await readText(cfgPath)) || {}; }
  catch { cfg = {}; }
  const skip: Record<string, boolean> = {};
  for (const srv of managedServers) {
    if (srv?.name) skip[srv.name as string] = true;
  }
  cfg.operonSkipMcpApprovals = skip;
  await mkdir(getWriteRoot(), { recursive: true });
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  return { written: Object.keys(skip).length };
}

export async function coworkGet(): Promise<unknown> {
  const installed = await (async () => {
    for (const dir of [...getCandidateRoots(), ...getAppInstallPaths()]) {
      if (await fileExists(dir)) return true;
    }
    return false;
  })();
  if (!installed) return { installed: false, config: null, message: "Claude Desktop (Cowork mode) not detected" };
  const meta = (await readJsonWithDeps(join(await resolveAppRootForRead(), "configLibrary", "_meta.json"), {})) as { appliedId?: string } | null;
  const appliedId = meta?.appliedId ?? null;
  const configDir = join(await resolveAppRootForRead(), "configLibrary");
  const configPath = appliedId ? join(configDir, `${appliedId}.json`) : null;
  const config = configPath ? (await readJsonWithDeps(configPath, {}) as Record<string, unknown> | null) : null;
  const baseUrl = (config?.inferenceGatewayBaseUrl as string | undefined) ?? null;
  const models = Array.isArray(config?.inferenceModels)
    ? (config.inferenceModels as Array<unknown>).map((m) => (typeof m === "string" ? m : (m as { name?: string })?.name)).filter(Boolean) as string[]
    : [];
  const managedMcp = Array.isArray(config?.managedMcpServers) ? (config.managedMcpServers as Array<Record<string, unknown>>) : [];
  const has9Router = !!(config?.inferenceProvider === "gateway" && baseUrl);
  const stdioNames = new Set(COWORK_LOCAL_STDIO_PLUGINS_MUTABLE.map((p) => p.name));
  const activeLocalNames = managedMcp
    .filter((m) => stdioNames.has(m.name as string) && typeof m.url === "string" && m.url.includes("/api/mcp/"))
    .map((m) => m.name as string);
  const activeCustomPlugins = managedMcp
    .filter((m) => m.custom || (!stdioNames.has(m.name as string) && typeof m.url === "string" && m.url.includes("/api/mcp/")))
    .map((m) => ({ name: m.name, url: m.url, transport: m.transport, custom: true }));
  return {
    installed: true,
    config,
    has9Router,
    configPath,
    cowork: {
      appliedId,
      baseUrl,
      models,
      provider: (config?.inferenceProvider as string | undefined) ?? null,
      plugins: managedMcp.filter((m) => !m.custom && !(stdioNames.has(m.name as string) && typeof m.url === "string" && m.url.includes("/api/mcp/"))).map((m) => {
        const keys = m.toolPolicy ? Object.keys(m.toolPolicy as Record<string, string>) : [];
        const prefix = `${m.name}-`;
        const bare = new Set<string>();
        for (const k of keys) {
          let t = k;
          while (t.startsWith(prefix)) t = t.slice(prefix.length);
          bare.add(t);
        }
        const def = COWORK_DEFAULT_PLUGINS_MUTABLE.find((d) => d.name === m.name);
        const toolNames = def && def.toolNames ? [...def.toolNames] : Array.from(bare);
        return { name: m.name, url: m.url, transport: m.transport, oauth: !!m.oauth, toolNames };
      }),
      localPlugins: activeLocalNames,
      customPlugins: activeCustomPlugins,
    },
    defaultPlugins: COWORK_DEFAULT_PLUGINS_MUTABLE,
    localStdioPlugins: COWORK_LOCAL_STDIO_PLUGINS_MUTABLE,
  };
}

export async function coworkApply(
  body: { baseUrl?: unknown; apiKey?: unknown; models?: unknown; plugins?: unknown; localPlugins?: unknown; customPlugins?: unknown },
): Promise<{ success: true; bootstrapped: boolean; message: string; configPath: string; skipApprovals: unknown; localMcp: unknown } | { error: string }> {
  const { baseUrl, apiKey } = body;
  if (typeof baseUrl !== "string" || !baseUrl || typeof apiKey !== "string" || !apiKey) {
    return { error: "baseUrl and apiKey are required" };
  }
  const modelsArray = Array.isArray(body.models)
    ? (body.models as unknown[]).filter((m): m is string => typeof m === "string" && m.trim() !== "")
    : [];
  if (modelsArray.length === 0) return { error: "At least one model is required" };
  const pluginsArray = Array.isArray(body.plugins) ? (body.plugins as CoworkPlugin[]) : COWORK_DEFAULT_PLUGINS_MUTABLE;
  const localPluginNames = Array.isArray(body.localPlugins) ? (body.localPlugins as string[]) : [];
  const customPluginsArray = (Array.isArray(body.customPlugins) ? (body.customPlugins as Array<{ name?: string; url?: string }>) : []).filter((p) => p?.url);

  const token = await getCliToken();
  const bridgeEntries = injectAuthHeaders(buildLocalBridgeEntries(localPluginNames), token);
  const customEntries = injectAuthHeaders(buildCustomEntries(customPluginsArray), token);
  const managedMcpServers = [...buildManagedMcpServers(pluginsArray), ...bridgeEntries, ...customEntries];

  const bootstrapped = await bootstrapDeploymentMode();
  const meta = await ensureMeta();
  const configPath = join(getWriteConfigDir(), `${meta.appliedId}.json`);

  const newConfig: Record<string, unknown> = {
    ...SECURITY_RELAX,
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: baseUrl,
    inferenceGatewayApiKey: apiKey,
    inferenceModels: modelsArray.map((name) => ({ name })),
  };
  if (managedMcpServers.length > 0) newConfig.managedMcpServers = managedMcpServers;
  await mkdir(getWriteConfigDir(), { recursive: true });
  await writeFile(configPath, JSON.stringify(newConfig, null, 2));

  let skipResult: unknown;
  try { skipResult = await writeSkipApprovals(managedMcpServers); } catch (err) { skipResult = { error: (err as Error).message }; }
  try { await cleanup1pLegacy(); } catch { /* ignore */ }
  return {
    success: true,
    bootstrapped,
    message: bootstrapped
      ? "Cowork enabled (3p mode set). Quit & reopen Claude Desktop."
      : "Cowork settings applied. Quit & reopen Claude Desktop.",
    configPath,
    skipApprovals: skipResult,
    localMcp: { applied: localPluginNames, via: "3p-sse-bridge" },
  };
}

export async function coworkReset(): Promise<{ success: true; message: string }> {
  const meta = (await readJsonWithDeps(join(await resolveAppRootForRead(), "configLibrary", "_meta.json"), {})) as { appliedId?: string } | null;
  if (!meta?.appliedId) return { success: true, message: "No active config to reset" };
  const configPath = join(await resolveAppRootForRead(), "configLibrary", `${meta.appliedId}.json`);
  try {
    await mkdir(join(await resolveAppRootForRead(), "configLibrary"), { recursive: true });
    await writeFile(configPath, JSON.stringify({}, null, 2));
  } catch { /* ignore */ }
  try { await writeSkipApprovals([]); } catch { /* ignore */ }
  try { await cleanup1pLegacy(); } catch { /* ignore */ }
  return { success: true, message: "Cowork config reset" };
}
