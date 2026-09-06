// DeepSeek TUI settings: ~/.deepseek/config.toml.
// Ported from 9router deepseek-tui-settings route (full-overwrite semantics).

import { join } from "node:path";
import { homedir } from "node:os";
import { ensureV1, fileExists, isBinaryOnPath, writeText, type ToolDeps } from "./core.ts";

export const deepseekPath = () => join(homedir(), ".deepseek", "config.toml");

const DEFAULT_CONFIG = `provider = "deepseek"\n`;

function build9RouterConfig(baseUrl: string, apiKey: string, model: string): string {
  const normalized = ensureV1(baseUrl);
  return `provider = "openai"\n\n[providers.openai]\nbase_url = "${normalized}"\napi_key = "${apiKey}"\nmodel = "${model}"\n`;
}

function has9RouterConfig(toml: string | null): boolean {
  if (!toml) return false;
  return /provider\s*=\s*"openai"/.test(toml) && /\[providers\.openai\]/.test(toml)
    && /base_url\s*=\s*"[^"]*(localhost|127\.0\.0\.1|0\.0\.0\.0)[^"]*"/.test(toml);
}

export async function deepseekGet(deps: ToolDeps = {}): Promise<unknown> {
  const path = deepseekPath();
  const installed = (await isBinaryOnPath("deepseek", deps)) || (await fileExists(path, deps));
  if (!installed) return { installed: false, settings: null, message: "DeepSeek TUI is not installed" };
  let toml: string | null = null;
  try { toml = await (deps.readFile ?? ((p: string) => import("node:fs/promises").then((fs) => fs.readFile(p, "utf-8"))))(path); } catch { toml = null; }
  return {
    installed: true,
    settings: { raw: toml },
    has9Router: has9RouterConfig(toml),
    configPath: path,
  };
}

export async function deepseekApply(
  body: { baseUrl?: unknown; apiKey?: unknown; model?: unknown },
  deps: ToolDeps = {},
): Promise<{ success: true; message: string; configPath: string } | { error: string }> {
  const { baseUrl, apiKey, model } = body;
  if (typeof baseUrl !== "string" || !baseUrl || typeof model !== "string" || !model) {
    return { error: "baseUrl and model are required" };
  }
  const path = deepseekPath();
  const keyToUse = (typeof apiKey === "string" && apiKey) || "sk_9router";
  await writeText(path, build9RouterConfig(baseUrl, keyToUse, model), deps);
  return { success: true, message: "DeepSeek TUI settings applied successfully!", configPath: path };
}

export async function deepseekReset(deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const path = deepseekPath();
  if (!(await fileExists(path, deps))) return { success: true, message: "No config file to reset" };
  await writeText(path, DEFAULT_CONFIG, deps);
  return { success: true, message: "Fast 9Router config reset to DeepSeek defaults" };
}
