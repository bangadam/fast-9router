// Copilot settings: VS Code chatLanguageModels.json.
// Ported from 9router copilot-settings route.

import { join } from "node:path";
import { homedir, platform } from "node:os";
import { readJsonWithDeps, writeJsonDeps, type ToolDeps } from "./core.ts";

export function copilotPath(): string {
  const home = homedir();
  if (platform() === "win32") {
    return join(process.env.APPDATA || home, "Code", "User", "chatLanguageModels.json");
  }
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  }
  return join(home, ".config", "Code", "User", "chatLanguageModels.json");
}

export async function copilotGet(deps: ToolDeps = {}): Promise<unknown> {
  const path = copilotPath();
  const config = await readJsonWithDeps(path, deps);
  const entry = Array.isArray(config) ? (config as Array<{ name?: string; models?: Array<{ id?: string; url?: string }> }>).find((e) => e.name === "9Router") ?? null : null;
  return {
    installed: true,
    config,
    has9Router: Array.isArray(config) && (config as Array<{ name?: string }>).some((e) => e.name === "9Router"),
    configPath: path,
    currentModel: entry?.models?.[0]?.id ?? null,
    currentUrl: entry?.models?.[0]?.url ?? null,
  };
}

export async function copilotApply(
  body: { baseUrl?: unknown; apiKey?: unknown; models?: unknown },
  deps: ToolDeps = {},
): Promise<{ success: true; message: string; configPath: string } | { error: string }> {
  const { baseUrl, apiKey } = body;
  const models = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string" && !!m) : [];
  if (typeof baseUrl !== "string" || !baseUrl || models.length === 0) {
    return { error: "baseUrl and models are required" };
  }
  const path = copilotPath();
  const parsed = await readJsonWithDeps(path, deps);
  const config = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  const endpointUrl = `${baseUrl}/chat/completions#models.ai.azure.com`;
  const keyToUse = (typeof apiKey === "string" && apiKey) || "sk_9router";
  const newEntry = {
    name: "9Router",
    vendor: "azure",
    apiKey: keyToUse,
    models: models.map((id) => ({
      id,
      name: id,
      url: endpointUrl,
      toolCalling: true,
      vision: false,
      maxInputTokens: 128000,
      maxOutputTokens: 16000,
    })),
  };
  const idx = config.findIndex((e) => e.name === "9Router");
  if (idx >= 0) config[idx] = newEntry;
  else config.push(newEntry);
  await writeJsonDeps(path, config, deps);
  return { success: true, message: "Copilot settings applied! Reload VS Code to take effect.", configPath: path };
}

export async function copilotReset(deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const path = copilotPath();
  const parsed = await readJsonWithDeps(path, deps);
  if (parsed === null) return { success: true, message: "No config file to reset" };
  const config = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>).filter((e) => e.name !== "9Router") : [];
  await writeJsonDeps(path, config, deps);
  return { success: true, message: "Fast 9Router removed from Copilot config" };
}
