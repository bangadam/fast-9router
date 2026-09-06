// Kilo Code settings: ~/.local/share/kilo/auth.json (+ best-effort VS Code settings).
// Ported from 9router kilo-settings route.

import { join } from "node:path";
import { homedir } from "node:os";
import { ensureV1, fileExists, isBinaryOnPath, readJsonWithDeps, writeJsonDeps, type ToolDeps } from "./core.ts";

export const kiloPaths = () => ({
  dataDir: join(homedir(), ".local", "share", "kilo"),
  auth: join(homedir(), ".local", "share", "kilo", "auth.json"),
  vscode: join(homedir(), ".config", "Code", "User", "settings.json"),
});

export async function kiloGet(deps: ToolDeps = {}): Promise<unknown> {
  const paths = kiloPaths();
  const installed = (await isBinaryOnPath("kilo", deps)) || (await fileExists(paths.auth, deps));
  if (!installed) return { installed: false, settings: null, message: "Kilo Code CLI is not installed" };
  const auth = await readJsonWithDeps(paths.auth, deps) as Record<string, { baseUrl?: string; baseURL?: string }> | null;
  const entry = auth?.["openai-compatible"] ?? auth?.["9router"];
  const baseUrl = entry?.baseUrl ?? entry?.baseURL ?? "";
  return {
    installed: true,
    settings: { auth: auth ? Object.keys(auth) : [] },
    has9Router: !!entry && (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("9router")),
    authPath: paths.auth,
  };
}

export async function kiloApply(
  body: { baseUrl?: unknown; apiKey?: unknown; model?: unknown },
  deps: ToolDeps = {},
): Promise<{ success: true; message: string; authPath: string } | { error: string }> {
  const { baseUrl, apiKey, model } = body;
  if (typeof baseUrl !== "string" || !baseUrl || typeof apiKey !== "string" || !apiKey || typeof model !== "string" || !model) {
    return { error: "baseUrl, apiKey and model are required" };
  }
  const paths = kiloPaths();
  const normalized = ensureV1(baseUrl);
  const auth = (await readJsonWithDeps(paths.auth, deps) as Record<string, unknown> | null) ?? {};
  auth["openai-compatible"] = { type: "api-key", apiKey, baseUrl: normalized, model };
  await writeJsonDeps(paths.auth, auth, deps);
  // Best-effort VS Code extension settings.
  try {
    const vscode = (await readJsonWithDeps(paths.vscode, deps) as Record<string, unknown> | null) ?? {};
    vscode["kilocode.customProvider"] = { name: "Fast 9Router", baseURL: normalized, apiKey };
    vscode["kilocode.defaultModel"] = model;
    await writeJsonDeps(paths.vscode, vscode, deps);
  } catch { /* not writable */ }
  return { success: true, message: "Kilo Code settings applied successfully!", authPath: paths.auth };
}

export async function kiloReset(deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const paths = kiloPaths();
  const auth = await readJsonWithDeps(paths.auth, deps) as Record<string, unknown> | null;
  if (auth === null) return { success: true, message: "No settings file to reset" };
  delete auth["openai-compatible"];
  delete auth["9router"];
  await writeJsonDeps(paths.auth, auth, deps);
  try {
    const vscode = await readJsonWithDeps(paths.vscode, deps) as Record<string, unknown> | null;
    if (vscode) {
      delete vscode["kilocode.customProvider"];
      delete vscode["kilocode.defaultModel"];
      await writeJsonDeps(paths.vscode, vscode, deps);
    }
  } catch { /* ignore */ }
  return { success: true, message: "Fast 9Router settings removed from Kilo Code" };
}
