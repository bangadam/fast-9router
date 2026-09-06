// OpenCode settings: ~/.config/opencode/opencode.json.
// Ported from 9router opencode-settings route (multi-model + explorer subagent).

import { join } from "node:path";
import { homedir } from "node:os";
import { PROVIDER_NAME, ensureV1, fileExists, isBinaryOnPath, readJsonWithDeps, writeJsonDeps, type ToolDeps } from "./core.ts";

export const opencodePath = () => join(homedir(), ".config", "opencode", "opencode.json");

export async function opencodeGet(deps: ToolDeps = {}): Promise<unknown> {
  const path = opencodePath();
  const installed = (await isBinaryOnPath("opencode", deps)) || (await fileExists(path, deps));
  if (!installed) return { installed: false, config: null, message: "OpenCode CLI is not installed" };
  const config = (await readJsonWithDeps(path, deps)) as Record<string, unknown> | null;
  const providerConfig = (config?.provider as Record<string, unknown> | undefined)?.[PROVIDER_NAME] as Record<string, unknown> | undefined;
  const modelMap = (providerConfig?.models as Record<string, unknown> | undefined) ?? {};
  const model = typeof config?.model === "string" ? config.model : "";
  return {
    installed: true,
    config,
    has9Router: !!providerConfig,
    configPath: path,
    opencode: {
      models: Object.keys(modelMap),
      activeModel: model.startsWith(`${PROVIDER_NAME}/`) ? model.slice(PROVIDER_NAME.length + 1) : null,
      baseURL: ((providerConfig?.options as Record<string, unknown> | undefined)?.baseURL as string | undefined) ?? null,
    },
  };
}

function modelsArrayFrom(body: { model?: unknown; models?: unknown }): string[] {
  if (Array.isArray(body.models)) return body.models.filter((m): m is string => typeof m === "string" && !!m);
  if (typeof body.model === "string" && body.model) return [body.model];
  return [];
}

export async function opencodeApply(
  body: { baseUrl?: unknown; apiKey?: unknown; model?: unknown; models?: unknown; activeModel?: unknown; subagentModel?: unknown },
  deps: ToolDeps = {},
): Promise<{ success: true; message: string; configPath: string } | { error: string }> {
  const { baseUrl, apiKey } = body;
  const modelsArray = modelsArrayFrom(body);
  if (typeof baseUrl !== "string" || !baseUrl || modelsArray.length === 0) {
    return { error: "baseUrl and at least one model are required" };
  }
  const path = opencodePath();
  const config = (await readJsonWithDeps(path, deps)) as Record<string, unknown> ?? {};
  const provider = (config.provider as Record<string, unknown> | undefined) ?? {};
  const existing = (provider[PROVIDER_NAME] as Record<string, unknown> | undefined) ?? { npm: "@ai-sdk/openai-compatible", options: {}, models: {} };
  existing.options = {
    ...((existing.options as Record<string, unknown>) ?? {}),
    baseURL: ensureV1(baseUrl),
    apiKey: apiKey || "sk_9router",
  };
  const models = (existing.models as Record<string, unknown> | undefined) ?? {};
  for (const m of modelsArray) {
    models[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
  }
  existing.models = models;
  provider[PROVIDER_NAME] = existing;
  config.provider = provider;
  if (body.activeModel === "") {
    config.model = "";
  } else {
    const finalActive = (typeof body.activeModel === "string" && body.activeModel) || modelsArray[0]!;
    config.model = `${PROVIDER_NAME}/${finalActive}`;
  }
  const agent = (config.agent as Record<string, unknown> | undefined) ?? {};
  const subagent = (typeof body.subagentModel === "string" && body.subagentModel) || modelsArray[0]!;
  agent.explorer = {
    description: "Fast explorer subagent for codebase exploration",
    mode: "subagent",
    model: `${PROVIDER_NAME}/${subagent}`,
  };
  config.agent = agent;
  await writeJsonDeps(path, config, deps);
  return { success: true, message: "OpenCode settings applied successfully!", configPath: path };
}

export async function opencodeClearActive(deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const path = opencodePath();
  const config = await readJsonWithDeps(path, deps) as Record<string, unknown> | null;
  if (config === null) return { success: true, message: "No config file found" };
  if (typeof config.model === "string" && config.model.startsWith(`${PROVIDER_NAME}/`)) config.model = "";
  await writeJsonDeps(path, config, deps);
  return { success: true, message: "Settings updated" };
}

export async function opencodeReset(modelToRemove: string | null, deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const path = opencodePath();
  const config = await readJsonWithDeps(path, deps) as Record<string, unknown> | null;
  if (config === null) return { success: true, message: "No config file to reset" };
  const provider = config.provider as Record<string, Record<string, unknown>> | undefined;
  if (provider?.[PROVIDER_NAME]) {
    const entry = provider[PROVIDER_NAME]!;
    if (modelToRemove && entry.models) {
      delete (entry.models as Record<string, unknown>)[modelToRemove];
      const remaining = Object.keys((entry.models as Record<string, unknown>) ?? {});
      if (remaining.length === 0) {
        delete provider[PROVIDER_NAME];
        if (typeof config.model === "string" && config.model.startsWith(`${PROVIDER_NAME}/`)) delete config.model;
      } else if (config.model === `${PROVIDER_NAME}/${modelToRemove}`) {
        config.model = `${PROVIDER_NAME}/${remaining[0]}`;
      }
    } else {
      delete provider[PROVIDER_NAME];
      if (typeof config.model === "string" && config.model.startsWith(`${PROVIDER_NAME}/`)) delete config.model;
    }
  }
  const agent = config.agent as Record<string, Record<string, unknown>> | undefined;
  if (typeof agent?.explorer?.model === "string" && agent.explorer.model.startsWith(`${PROVIDER_NAME}/`)) {
    delete agent.explorer;
    if (Object.keys(agent).length === 0) delete config.agent;
  }
  await writeJsonDeps(path, config, deps);
  return {
    success: true,
    message: modelToRemove ? `Model "${modelToRemove}" removed` : "Fast 9Router settings removed from OpenCode",
  };
}
