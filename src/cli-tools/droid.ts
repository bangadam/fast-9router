// Factory Droid settings: ~/.factory/settings.json customModels.
// Ported from 9router droid-settings route.

import { join } from "node:path";
import { homedir } from "node:os";
import { PROVIDER_NAME, ensureV1, fileExists, isBinaryOnPath, readJsonWithDeps, writeJsonDeps, type ToolDeps } from "./core.ts";

export const droidPath = () => join(homedir(), ".factory", "settings.json");

export async function droidGet(deps: ToolDeps = {}): Promise<unknown> {
  const path = droidPath();
  const installed = (await isBinaryOnPath("droid", deps)) || (await fileExists(path, deps));
  if (!installed) return { installed: false, settings: null, message: "Factory Droid CLI is not installed" };
  const settings = await readJsonWithDeps(path, deps);
  const customModels = (settings as { customModels?: Array<{ id?: string }> } | null)?.customModels ?? [];
  return {
    installed: true,
    settings,
    has9Router: customModels.some((m) => m.id?.startsWith(`custom:${PROVIDER_NAME}`)),
    settingsPath: path,
  };
}

export async function droidApply(
  body: { baseUrl?: unknown; apiKey?: unknown; model?: unknown; models?: unknown; activeModel?: unknown },
  deps: ToolDeps = {},
): Promise<{ success: true; message: string; settingsPath: string } | { error: string }> {
  const { baseUrl, apiKey } = body;
  const modelsArray = Array.isArray(body.models)
    ? body.models.filter((m): m is string => typeof m === "string" && !!m)
    : typeof body.model === "string" && body.model ? [body.model] : [];
  if (typeof baseUrl !== "string" || !baseUrl || modelsArray.length === 0) {
    return { error: "baseUrl and at least one model are required" };
  }
  const path = droidPath();
  const settings = (await readJsonWithDeps(path, deps)) as Record<string, unknown> ?? {};
  const customModels = (settings.customModels as Array<Record<string, unknown>> | undefined) ?? [];
  const entries = customModels.filter((m) => !String(m.id ?? "").startsWith(`custom:${PROVIDER_NAME}`));
  const normalized = ensureV1(baseUrl);
  const keyToUse = (typeof apiKey === "string" && apiKey) || "your_api_key";
  let defaultIndex = 0;
  if (typeof body.activeModel === "string") {
    defaultIndex = body.activeModel === "" ? -1 : (modelsArray.indexOf(body.activeModel) >= 0 ? modelsArray.indexOf(body.activeModel) : 0);
  }
  for (let i = 0; i < modelsArray.length; i++) {
    entries.push({
      model: modelsArray[i],
      id: `custom:${PROVIDER_NAME}-${i}`,
      index: i,
      baseUrl: normalized,
      apiKey: keyToUse,
      displayName: modelsArray[i],
      maxOutputTokens: 131072,
      noImageSupport: false,
      provider: "openai",
    });
  }
  if (defaultIndex >= 0 && entries[defaultIndex]) {
    const [defaultEntry] = entries.splice(defaultIndex, 1);
    entries.unshift({ ...defaultEntry!, index: 0 });
    entries.forEach((m, i) => { m.index = i; });
  }
  settings.customModels = entries;
  await writeJsonDeps(path, settings, deps);
  return { success: true, message: "Factory Droid settings applied successfully!", settingsPath: path };
}

export async function droidReset(deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const path = droidPath();
  const settings = await readJsonWithDeps(path, deps) as Record<string, unknown> | null;
  if (settings === null) return { success: true, message: "No settings file to reset" };
  const customModels = settings.customModels as Array<Record<string, unknown>> | undefined;
  if (customModels) {
    const kept = customModels.filter((m) => !String(m.id ?? "").startsWith(`custom:${PROVIDER_NAME}`));
    if (kept.length === 0) delete settings.customModels;
    else settings.customModels = kept;
  }
  await writeJsonDeps(path, settings, deps);
  return { success: true, message: "Fast 9Router settings removed successfully" };
}
