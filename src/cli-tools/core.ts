// CLI tool settings core: JSON/env/TOML primitives, binary detection.
// Ported from 9router's /api/cli-tools/* route handlers.

import { access, constants, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseTomlLib, stringify as stringifyTomlLib } from "smol-toml";

export const PROVIDER_NAME = "fast-9router";

// ---------------------------------------------------------------------------
// Filesystem seams (tests inject overrides)
// ---------------------------------------------------------------------------
export type ToolDeps = {
  isBinaryOnPath?: (binary: string) => Promise<boolean>;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, content: string) => Promise<void>;
  exists?: (path: string) => Promise<boolean>;
};

export async function fileExists(path: string, deps: ToolDeps = {}): Promise<boolean> {
  if (deps.exists) return deps.exists(path);
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

export async function writeJsonDeps(path: string, value: unknown, deps: ToolDeps): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeText(path, content, deps);
}

/** Binary detection mirrors legacy which/where, without spawning a shell. */
export async function isBinaryOnPath(binary: string, deps: ToolDeps = {}): Promise<boolean> {
  if (deps.isBinaryOnPath) return deps.isBinaryOnPath(binary);
  const isWin = platform() === "win32";
  const names = isWin ? [`${binary}.exe`, `${binary}.cmd`, `${binary}.bat`, binary] : [binary];
  const dirs = (process.env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean);
  for (const dir of dirs) for (const name of names) {
    if (await fileExists(join(dir, name))) return true;
  }
  return false;
}

const reader = (deps: ToolDeps) => deps.readFile ?? ((path: string) => readFile(path, "utf-8"));
const writer = (deps: ToolDeps) => deps.writeFile ?? ((path: string, content: string) => writeFile(path, content));

export async function readText(path: string, deps: ToolDeps = {}): Promise<string> {
  return reader(deps)(path);
}

export async function writeText(path: string, content: string, deps: ToolDeps = {}): Promise<void> {
  if (deps.writeFile) return deps.writeFile(path, content);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** JSONC-tolerant read: strips trailing commas; missing/unparseable → null. */
export async function readJsonWithDeps(path: string, deps: ToolDeps): Promise<unknown> {
  try {
    const content = await reader(deps)(path);
    return JSON.parse(String(content).replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function removeFile(path: string): Promise<void> {
  await unlink(path);
}

export function ensureV1(url: string): string {
  return url.endsWith("/v1") ? url : `${url}/v1`;
}

// --- TOML ------------------------------------------------------------------

export function parseToml(content: string): Record<string, unknown> {
  return parseTomlLib(content) as Record<string, unknown>;
}

export function stringifyToml(value: unknown): string {
  return stringifyTomlLib(value as Record<string, unknown>);
}

// --- env (KEY=VALUE lines, '#' comments) -------------------------------------

export function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function stringifyEnv(env: Record<string, string>, header: string): string {
  let content = header;
  for (const [key, value] of Object.entries(env)) content += `${key}="${value}"\n`;
  return content;
}
