// Cline settings: ~/.cline/data/globalState.json + secrets.json.
// Ported from 9router cline-settings route.

import { join } from "node:path";
import { homedir } from "node:os";
import { fileExists, isBinaryOnPath, readJsonWithDeps, writeJsonDeps, type ToolDeps } from "./core.ts";

export const clinePaths = () => ({
  dataDir: join(homedir(), ".cline", "data"),
  globalState: join(homedir(), ".cline", "data", "globalState.json"),
  secrets: join(homedir(), ".cline", "data", "secrets.json"),
});

export async function clineGet(deps: ToolDeps = {}): Promise<unknown> {
  const paths = clinePaths();
  const installed = (await isBinaryOnPath("cline", deps)) || (await fileExists(paths.globalState, deps));
  if (!installed) return { installed: false, settings: null, message: "Cline CLI is not installed" };
  const globalState = await readJsonWithDeps(paths.globalState, deps) as Record<string, unknown> | null;
  const isOpenAi = globalState?.actModeApiProvider === "openai" || globalState?.planModeApiProvider === "openai";
  const baseUrl = typeof globalState?.openAiBaseUrl === "string" ? globalState.openAiBaseUrl : "";
  return {
    installed: true,
    settings: {
      actModeApiProvider: globalState?.actModeApiProvider,
      planModeApiProvider: globalState?.planModeApiProvider,
      openAiBaseUrl: globalState?.openAiBaseUrl,
      openAiModelId: globalState?.openAiModelId,
    },
    has9Router: !!globalState && isOpenAi && (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("9router")),
    globalStatePath: paths.globalState,
  };
}

export async function clineApply(
  body: { baseUrl?: unknown; apiKey?: unknown; model?: unknown },
  deps: ToolDeps = {},
): Promise<{ success: true; message: string; globalStatePath: string } | { error: string }> {
  const { baseUrl, apiKey, model } = body;
  if (typeof baseUrl !== "string" || !baseUrl || typeof apiKey !== "string" || !apiKey || typeof model !== "string" || !model) {
    return { error: "baseUrl, apiKey and model are required" };
  }
  const paths = clinePaths();
  // Cline expects the base URL WITHOUT /v1.
  const normalized = baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
  const globalState = (await readJsonWithDeps(paths.globalState, deps) as Record<string, unknown> | null) ?? {};
  globalState.actModeApiProvider = "openai";
  globalState.planModeApiProvider = "openai";
  globalState.openAiBaseUrl = normalized;
  globalState.openAiModelId = model;
  globalState.planModeOpenAiModelId = model;
  await writeJsonDeps(paths.globalState, globalState, deps);
  const secrets = (await readJsonWithDeps(paths.secrets, deps) as Record<string, unknown> | null) ?? {};
  secrets.openAiApiKey = apiKey;
  await writeJsonDeps(paths.secrets, secrets, deps);
  return { success: true, message: "Cline settings applied successfully!", globalStatePath: paths.globalState };
}

export async function clineReset(deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const paths = clinePaths();
  const globalState = await readJsonWithDeps(paths.globalState, deps) as Record<string, unknown> | null;
  if (globalState === null) return { success: true, message: "No settings file to reset" };
  if (globalState.actModeApiProvider === "openai") {
    delete globalState.openAiBaseUrl;
    delete globalState.openAiModelId;
    delete globalState.planModeOpenAiModelId;
    globalState.actModeApiProvider = "cline";
    globalState.planModeApiProvider = "cline";
  }
  await writeJsonDeps(paths.globalState, globalState, deps);
  const secrets = (await readJsonWithDeps(paths.secrets, deps) as Record<string, unknown> | null) ?? {};
  delete secrets.openAiApiKey;
  await writeJsonDeps(paths.secrets, secrets, deps);
  return { success: true, message: "Fast 9Router settings removed from Cline" };
}
