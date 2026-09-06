// Claude ([CC]) settings: ~/.claude/settings.json + ~/.claude.json (Exa MCP).
// Ported from 9router claude-settings route.

import { join } from "node:path";
import { homedir } from "node:os";
import {
  ensureV1, fileExists, isBinaryOnPath, readJsonWithDeps,
  writeJsonDeps, writeText, type ToolDeps,
} from "./core.ts";

export const claudePaths = () => ({
  settings: join(homedir(), ".claude", "settings.json"),
  claudeJson: join(homedir(), ".claude.json"),
});

export const CLAUDE_RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
];

export const CLAUDE_MODEL_SLOTS = [
  { id: "fable", label: "the model", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL" },
  { id: "opus", label: "the model", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
  { id: "sonnet", label: "the model", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL" },
  { id: "haiku", label: "the model", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL" },
] as const;

async function writeClaudeJsonMcp(claudeJsonPath: string, mcpServers: Record<string, unknown> | null, deps: ToolDeps) {
  const data = (await readJsonWithDeps(claudeJsonPath, deps)) as Record<string, unknown> ?? {};
  const existing = (data.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    data.mcpServers = { ...existing, ...mcpServers };
  } else if (data.mcpServers) {
    const next = { ...existing };
    delete next.exa;
    if (Object.keys(next).length === 0) delete data.mcpServers;
    else data.mcpServers = next;
  }
  await writeText(claudeJsonPath, JSON.stringify(data, null, 2), deps);
}

export async function claudeGet(deps: ToolDeps = {}): Promise<unknown> {
  const paths = claudePaths();
  const installed = (await isBinaryOnPath("claude", deps)) || (await fileExists(paths.settings, deps));
  if (!installed) return { installed: false, settings: null, message: "Claude CLI is not installed" };
  const settings = await readJsonWithDeps(paths.settings, deps);
  const claudeJson = await readJsonWithDeps(paths.claudeJson, deps);
  return {
    installed: true,
    settings,
    has9Router: !!((settings as { env?: Record<string, unknown> } | null)?.env?.ANTHROPIC_BASE_URL),
    exaMcpEnabled: !!((claudeJson as { mcpServers?: Record<string, unknown> } | null)?.mcpServers?.exa),
    settingsPath: paths.settings,
  };
}

export async function claudeApply(
  body: { env?: unknown; exaMcpEnabled?: unknown; maxContextTokens?: unknown },
  deps: ToolDeps = {},
): Promise<{ success: true; message: string } | { error: string }> {
  const env = body.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return { error: "Invalid env object" };
  const paths = claudePaths();
  const current = (await readJsonWithDeps(paths.settings, deps)) as Record<string, unknown> ?? {};
  const envRecord = { ...(env as Record<string, unknown>) };
  if (typeof envRecord.ANTHROPIC_BASE_URL === "string" && envRecord.ANTHROPIC_BASE_URL) {
    envRecord.ANTHROPIC_BASE_URL = ensureV1(envRecord.ANTHROPIC_BASE_URL);
  }
  const mergedEnv = { ...((current.env as Record<string, unknown>) ?? {}), ...envRecord };
  if (body.maxContextTokens) mergedEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(body.maxContextTokens);
  else delete mergedEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  await writeText(paths.settings, JSON.stringify({ ...current, hasCompletedOnboarding: true, env: mergedEnv }, null, 2), deps);
  await writeClaudeJsonMcp(
    paths.claudeJson,
    body.exaMcpEnabled ? { exa: { type: "http", url: "https://mcp.exa.ai/mcp" } } : null,
    deps,
  );
  return { success: true, message: "Settings updated successfully" };
}

export async function claudeReset(deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const paths = claudePaths();
  const current = await readJsonWithDeps(paths.settings, deps) as Record<string, unknown> | null;
  if (current === null) return { success: true, message: "No settings file to reset" };
  const env = (current.env as Record<string, unknown> | undefined) ?? {};
  for (const key of CLAUDE_RESET_ENV_KEYS) delete env[key];
  if (Object.keys(env).length === 0) delete current.env;
  else current.env = env;
  await writeText(paths.settings, JSON.stringify(current, null, 2), deps);
  await writeClaudeJsonMcp(paths.claudeJson, null, deps);
  return { success: true, message: "Settings reset successfully" };
}

