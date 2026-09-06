// OpenClaw settings: ~/.openclaw/openclaw.json + per-agent models.json.
// Ported from 9router openclaw-settings route.

import { join } from "node:path";
import { homedir } from "node:os";
import { PROVIDER_NAME, ensureV1, fileExists, isBinaryOnPath, readJsonWithDeps, writeJsonDeps, type ToolDeps } from "./core.ts";

export const openclawPath = () => join(homedir(), ".openclaw", "openclaw.json");

function resolveAgentModel(m: unknown): string {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") return String((m as { primary?: unknown }).primary ?? "");
  return "";
}

export async function openclawGet(deps: ToolDeps = {}): Promise<unknown> {
  const path = openclawPath();
  const installed = (await isBinaryOnPath("openclaw", deps)) || (await fileExists(path, deps));
  if (!installed) return { installed: false, settings: null, message: "Open Claw CLI is not installed" };
  const settings = await readJsonWithDeps(path, deps) as Record<string, unknown> | null;
  const agentList = (((settings?.agents as { list?: unknown[] } | undefined)?.list ?? []) as Array<Record<string, unknown>>);
  const enriched: unknown[] = [];
  for (const agent of agentList) {
    const agentDir = typeof agent.agentDir === "string" ? agent.agentDir : null;
    const currentModel = agentDir ? await readAgentModel(agentDir) : null;
    enriched.push({ ...agent, model: resolveAgentModel(agent.model), currentModel });
  }
  return {
    installed: true,
    settings,
    agents: enriched,
    has9Router: !!((settings?.models as { providers?: Record<string, unknown> } | undefined)?.providers?.[PROVIDER_NAME]),
    settingsPath: path,
  };
}

async function readAgentModel(agentDir: string): Promise<string | null> {
  const data = await readJsonWithDeps(join(agentDir, "models.json"), {}) as { providers?: Record<string, { models?: Array<{ id?: string }> }> } | null;
  return data?.providers?.[PROVIDER_NAME]?.models?.[0]?.id ?? null;
}

export async function openclawApply(
  body: { baseUrl?: unknown; apiKey?: unknown; model?: unknown; agentModels?: unknown },
  deps: ToolDeps = {},
): Promise<{ success: true; message: string; settingsPath: string } | { error: string }> {
  const { baseUrl, model } = body;
  if (typeof baseUrl !== "string" || !baseUrl || typeof model !== "string" || !model) {
    return { error: "baseUrl and model are required" };
  }
  const agentModels = (body.agentModels && typeof body.agentModels === "object" && !Array.isArray(body.agentModels))
    ? body.agentModels as Record<string, string>
    : {};
  const path = openclawPath();
  const settings = (await readJsonWithDeps(path, deps)) as Record<string, unknown> ?? {};
  const agents = ((settings.agents as Record<string, unknown> | undefined) ?? {});
  const defaults = ((agents.defaults as Record<string, unknown> | undefined) ?? {});
  defaults.model = (defaults.model as Record<string, unknown> | undefined) ?? {};
  defaults.models = (defaults.models as Record<string, unknown> | undefined) ?? {};
  settings.models = (settings.models as Record<string, unknown> | undefined) ?? {};
  (settings.models as Record<string, unknown>).providers = ((settings.models as { providers?: Record<string, unknown> }).providers ?? {}) as Record<string, unknown>;
  settings.agents = agents;
  agents.defaults = defaults;

  const normalized = ensureV1(baseUrl);
  const fullModelId = `${PROVIDER_NAME}/${model}`;
  const defaultsModels = defaults.models as Record<string, unknown>;
  for (const key of Object.keys(defaultsModels)) {
    if (key.startsWith(`${PROVIDER_NAME}/`)) delete defaultsModels[key];
  }
  (defaults.model as Record<string, unknown>).primary = fullModelId;
  const allModelIds = new Set<string>([model]);
  for (const m of Object.values(agentModels)) if (m) allModelIds.add(m);
  for (const m of allModelIds) defaultsModels[`${PROVIDER_NAME}/${m}`] = {};
  if (Array.isArray(agents.list)) {
    agents.list = (agents.list as Array<Record<string, unknown>>).map((agent) =>
      resolveAgentModel(agent.model).startsWith(`${PROVIDER_NAME}/`) ? (({ model: _model, ...rest }) => rest)(agent) : agent,
    );
  }
  const providers = (settings.models as { providers: Record<string, unknown> }).providers;
  providers[PROVIDER_NAME] = {
    baseUrl: normalized,
    apiKey: (body.apiKey as string) || "your_api_key",
    api: "openai-completions",
    models: [...allModelIds].map((m) => ({ id: m, name: m.split("/").pop() || m })),
  };
  if (Array.isArray(agents.list)) {
    agents.list = (agents.list as Array<Record<string, unknown>>).map((agent) => {
      const agentModel = agentModels[String(agent.id)];
      return agentModel ? { ...agent, model: `${PROVIDER_NAME}/${agentModel}` } : agent;
    });
    await Promise.all(
      (agents.list as Array<Record<string, unknown>>).map(async (agent) => {
        if (typeof agent.agentDir !== "string") return;
        const agentModel = agentModels[String(agent.id)] || model;
        const modelsPath = join(agent.agentDir, "models.json");
        const existing = (await readJsonWithDeps(modelsPath, deps)) as Record<string, unknown> ?? {};
        existing.providers = (existing.providers as Record<string, unknown> | undefined) ?? {};
        (existing.providers as Record<string, unknown>)[PROVIDER_NAME] = {
          baseUrl: normalized,
          apiKey: (body.apiKey as string) || "your_api_key",
          api: "openai-completions",
          models: [{ id: agentModel, name: agentModel.split("/").pop() || agentModel }],
        };
        await writeJsonDeps(modelsPath, existing, deps);
      }),
    );
  }
  await writeJsonDeps(path, settings, deps);
  return { success: true, message: "Open Claw settings applied successfully!", settingsPath: path };
}

export async function openclawReset(deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const path = openclawPath();
  const settings = await readJsonWithDeps(path, deps) as Record<string, unknown> | null;
  if (settings === null) return { success: true, message: "No settings file to reset" };
  const models = settings.models as { providers?: Record<string, unknown> } | undefined;
  if (models?.providers) {
    delete models.providers[PROVIDER_NAME];
    if (Object.keys(models.providers).length === 0) delete models.providers;
  }
  const defaults = (settings.agents as { defaults?: { models?: Record<string, unknown>; model?: { primary?: string } } } | undefined)?.defaults;
  if (defaults?.models) {
    for (const key of Object.keys(defaults.models)) {
      if (key.startsWith(`${PROVIDER_NAME}/`)) delete defaults.models[key];
    }
    if (Object.keys(defaults.models).length === 0) delete defaults.models;
  }
  if (defaults?.model?.primary?.startsWith(`${PROVIDER_NAME}/`)) delete defaults.model.primary;
  await writeJsonDeps(path, settings, deps);
  return { success: true, message: "Fast 9Router settings removed successfully" };
}
