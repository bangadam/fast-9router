// Hermes settings: ~/.hermes/config.yaml (model block) + ~/.hermes/.env.
// Ported from 9router hermes-settings route (textual YAML block editing).

import { join } from "node:path";
import { homedir } from "node:os";
import { ensureV1, fileExists, isBinaryOnPath, readText, writeText, type ToolDeps } from "./core.ts";

export const hermesPaths = () => ({
  dir: join(homedir(), ".hermes"),
  config: join(homedir(), ".hermes", "config.yaml"),
  env: join(homedir(), ".hermes", ".env"),
});

const MODEL_BLOCK_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;

function buildModelBlock(model: string, baseUrl: string): string {
  return `model:\n  default: "${model}"\n  provider: "custom"\n  base_url: "${baseUrl}"\n  api_key: \${OPENAI_API_KEY}\n`;
}

function parseModelBlock(yaml: string): { default: string | null; provider: string | null; base_url: string | null; api_key: string | null } | null {
  const match = yaml.match(MODEL_BLOCK_RE);
  if (!match) return null;
  const body = match[1] ?? "";
  const get = (key: string): string | null => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, "m"));
    return m ? m[1]!.trim() : null;
  };
  return { default: get("default"), provider: get("provider"), base_url: get("base_url"), api_key: get("api_key") };
}

function upsertModelBlock(yaml: string, newBlock: string): string {
  if (MODEL_BLOCK_RE.test(yaml)) return yaml.replace(MODEL_BLOCK_RE, newBlock);
  return yaml.length > 0 ? `${newBlock}\n${yaml}` : newBlock;
}

function removeModelBlock(yaml: string): string {
  return yaml.replace(MODEL_BLOCK_RE, "").replace(/^\n+/, "");
}

function upsertEnvVar(envText: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(envText)) return envText.replace(re, line);
  return envText.length > 0 && !envText.endsWith("\n") ? `${envText}\n${line}\n` : `${envText}${line}\n`;
}

async function readOrEmpty(path: string, deps: ToolDeps): Promise<string> {
  try { return await readText(path, deps); } catch { return ""; }
}

export async function hermesGet(deps: ToolDeps = {}): Promise<unknown> {
  const paths = hermesPaths();
  const installed = (await isBinaryOnPath("hermes", deps)) || (await fileExists(paths.config, deps));
  if (!installed) return { installed: false, settings: null, message: "Hermes Agent is not installed" };
  const yaml = await readOrEmpty(paths.config, deps);
  const model = parseModelBlock(yaml);
  return {
    installed: true,
    settings: { model },
    has9Router: !!model?.base_url && model.provider === "custom" && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(model.base_url),
    configPath: paths.config,
  };
}

export async function hermesApply(
  body: { baseUrl?: unknown; apiKey?: unknown; model?: unknown },
  deps: ToolDeps = {},
): Promise<{ success: true; message: string; configPath: string } | { error: string }> {
  const { baseUrl, apiKey, model } = body;
  if (typeof baseUrl !== "string" || !baseUrl || typeof model !== "string" || !model) {
    return { error: "baseUrl and model are required" };
  }
  const paths = hermesPaths();
  const yaml = await readOrEmpty(paths.config, deps);
  await writeText(paths.config, upsertModelBlock(yaml, buildModelBlock(model, ensureV1(baseUrl))), deps);
  if (typeof apiKey === "string" && apiKey) {
    const envText = await readOrEmpty(paths.env, deps);
    await writeText(paths.env, upsertEnvVar(envText, "OPENAI_API_KEY", apiKey), deps);
  }
  return { success: true, message: "Hermes settings applied successfully!", configPath: paths.config };
}

export async function hermesReset(deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const paths = hermesPaths();
  let yaml: string;
  try { yaml = await readText(paths.config, deps); }
  catch { return { success: true, message: "No config file to reset" }; }
  await writeText(paths.config, removeModelBlock(yaml), deps);
  return { success: true, message: "Fast 9Router model block removed" };
}
