// Codex settings: ~/.codex/config.toml (+ auth.json cleanup on reset).
// Ported from 9router codex-settings route.

import { join } from "node:path";
import { homedir } from "node:os";
import {
  PROVIDER_NAME, ensureV1, fileExists, isBinaryOnPath, parseToml, readJsonWithDeps,
  removeFile, stringifyToml, writeJsonDeps, writeText, type ToolDeps,
} from "./core.ts";

export const codexPaths = () => ({
  dir: join(homedir(), ".codex"),
  config: join(homedir(), ".codex", "config.toml"),
  auth: join(homedir(), ".codex", "auth.json"),
});

export async function codexGet(deps: ToolDeps = {}): Promise<unknown> {
  const paths = codexPaths();
  const installed = (await isBinaryOnPath("codex", deps)) || (await fileExists(paths.config, deps));
  if (!installed) return { installed: false, config: null, message: "Codex CLI is not installed" };
  let config: string | null = null;
  try { config = await deps.readFile?.(paths.config) ?? null; } catch { config = null; }
  if (config === null) {
    try { config = await (await import("node:fs/promises")).readFile(paths.config, "utf-8"); } catch { config = null; }
  }
  return {
    installed: true,
    config,
    has9Router: !!config && (config.includes(`model_provider = "${PROVIDER_NAME}"`) || config.includes(`[model_providers.${PROVIDER_NAME}]`)),
    configPath: paths.config,
  };
}

export async function codexApply(
  body: { baseUrl?: unknown; apiKey?: unknown; model?: unknown; subagentModel?: unknown },
  deps: ToolDeps = {},
): Promise<{ success: true; message: string; configPath: string } | { error: string }> {
  const { baseUrl, apiKey, model, subagentModel } = body;
  if (typeof baseUrl !== "string" || !baseUrl || typeof apiKey !== "string" || !apiKey || typeof model !== "string" || !model) {
    return { error: "baseUrl, apiKey and model are required" };
  }
  const paths = codexPaths();
  let parsed: Record<string, unknown> = {};
  try { parsed = parseToml(await readRaw(paths.config, deps)); } catch { /* fresh */ }
  parsed.model = model;
  parsed.model_provider = PROVIDER_NAME;
  const providers = (parsed.model_providers as Record<string, unknown> | undefined) ?? {};
  providers[PROVIDER_NAME] = {
    name: "Fast 9Router",
    base_url: ensureV1(baseUrl),
    wire_api: "responses",
    http_headers: { Authorization: `Bearer ${apiKey}` },
  };
  parsed.model_providers = providers;
  const agents = (parsed.agents as Record<string, unknown> | undefined) ?? {};
  delete agents.subagent;
  agents.default_subagent_model = (typeof subagentModel === "string" && subagentModel) || model;
  parsed.agents = agents;
  const content = stringifyToml(parsed);
  await writeText(paths.config, content, deps);
  return { success: true, message: "Codex settings applied successfully!", configPath: paths.config };
}

export async function codexReset(deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const paths = codexPaths();
  let parsed: Record<string, unknown>;
  try { parsed = parseToml(await readRaw(paths.config, deps)); }
  catch { return { success: true, message: "No config file to reset" }; }
  if (parsed.model_provider === PROVIDER_NAME) {
    delete parsed.model;
    delete parsed.model_provider;
  }
  const providers = parsed.model_providers as Record<string, unknown> | undefined;
  if (providers) {
    delete providers[PROVIDER_NAME];
    if (Object.keys(providers).length === 0) delete parsed.model_providers;
  }
  const agents = parsed.agents as Record<string, unknown> | undefined;
  if (agents) {
    delete agents.default_subagent_model;
    delete agents.subagent;
    if (Object.keys(agents).length === 0) delete parsed.agents;
  }
  await writeText(paths.config, stringifyToml(parsed), deps);
  const auth = await readJsonWithDeps(paths.auth, deps) as Record<string, unknown> | null;
  if (auth) {
    delete auth.OPENAI_API_KEY;
    delete auth.auth_mode;
    if (Object.keys(auth).length === 0) await removeFile(paths.auth);
    else await writeJsonDeps(paths.auth, auth, deps);
  }
  return { success: true, message: "Fast 9Router settings removed successfully" };
}

async function readRaw(path: string, deps: ToolDeps): Promise<string> {
  if (deps.readFile) return deps.readFile(path);
  return (await import("node:fs/promises")).readFile(path, "utf-8");
}
