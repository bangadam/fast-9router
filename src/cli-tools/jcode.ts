// jcode settings: ~/.jcode/config.toml + provider-9router.env.
// Ported from 9router jcode-settings route.

import { join } from "node:path";
import { homedir } from "node:os";
import {
  fileExists, isBinaryOnPath, parseEnv, parseToml, readText, stringifyEnv, stringifyToml,
  writeText, type ToolDeps,
} from "./core.ts";

export const jcodePaths = () => {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return {
    dir: join(homedir(), ".jcode"),
    config: join(homedir(), ".jcode", "config.toml"),
    env: join(configDir, "jcode", "provider-9router.env"),
  };
};

async function readConfig(deps: ToolDeps): Promise<Record<string, unknown>> {
  try { return parseToml(await readText(jcodePaths().config, deps)); }
  catch { return { providers: {} }; }
}

export async function jcodeGet(deps: ToolDeps = {}): Promise<unknown> {
  const paths = jcodePaths();
  const installed = (await isBinaryOnPath("jcode", deps)) || (await fileExists(paths.dir, deps));
  if (!installed) {
    return {
      installed: false,
      message: "jcode not installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash",
    };
  }
  const config = await readConfig(deps);
  const providers = (config.providers as Record<string, { base_url?: string }> | undefined) ?? {};
  const has9Router = !!providers["9router"]
    || Object.values(providers).some((p) => p.base_url?.includes("localhost:20128"));
  return { installed: true, config, has9Router, configPath: paths.config };
}

export async function jcodeApply(
  body: { baseUrl?: unknown; apiKey?: unknown; models?: unknown },
  deps: ToolDeps = {},
): Promise<{ success: true; message: string; configPath: string } | { error: string }> {
  const { baseUrl, apiKey } = body;
  if (typeof baseUrl !== "string" || !baseUrl || typeof apiKey !== "string" || !apiKey) {
    return { error: "baseUrl and apiKey are required" };
  }
  const paths = jcodePaths();
  const normalized = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  const config = await readConfig(deps);
  const providers = (config.providers as Record<string, unknown> | undefined) ?? {};
  const models = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string" && !!m) : [];
  providers["9router"] = {
    type: "openai-compatible",
    base_url: normalized,
    auth: "bearer",
    api_key_env: "JCODE_9ROUTER_API_KEY",
    env_file: "provider-9router.env",
    default_model: models[0] ?? "cc/",
    requires_api_key: true,
  };
  config.providers = providers;
  await writeText(paths.config, stringifyToml(config), deps);
  let env: Record<string, string> = {};
  try { env = parseEnv(await readText(paths.env, deps)); } catch { /* fresh */ }
  env.JCODE_9ROUTER_API_KEY = apiKey;
  await writeText(paths.env, stringifyEnv(env, "# jcode provider environment variables\n"), deps);
  return { success: true, message: "jcode configured successfully. Use: jcode --provider-profile 9router", configPath: paths.config };
}

export async function jcodeReset(deps: ToolDeps = {}): Promise<{ success: true; message: string }> {
  const paths = jcodePaths();
  const config = await readConfig(deps);
  const providers = config.providers as Record<string, unknown> | undefined;
  if (!providers) return { success: true, message: "No configuration to remove" };
  delete providers["9router"];
  await writeText(paths.config, stringifyToml(config), deps);
  let env: Record<string, string> = {};
  try { env = parseEnv(await readText(paths.env, deps)); } catch { /* fresh */ }
  delete env.JCODE_9ROUTER_API_KEY;
  await writeText(paths.env, stringifyEnv(env, "# jcode provider environment variables\n"), deps);
  return { success: true, message: "Fast 9Router configuration removed from jcode" };
}
