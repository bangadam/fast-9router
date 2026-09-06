// CLI tool settings routes: status/apply/reset against an isolated fake
// filesystem via ToolDeps, plus all-statuses aggregation and auth guards.

import { describe, expect, test } from "bun:test";
import { TOOL_HANDLERS } from "../src/cli-tools/registry.ts";
import type { ToolDeps } from "../src/cli-tools/core.ts";
import { makeApp, adminGet, adminJson } from "./helpers.ts";

function fakeFs(seed: Record<string, string> = {}, binaries: string[] = []): ToolDeps & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    exists: async (path) => files.has(path),
    isBinaryOnPath: async (binary) => binaries.includes(binary),
    readFile: async (path) => {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path)!;
    },
    writeFile: async (path, content) => { files.set(path, content); },
  };
}

// All-statuses over the real production deps (actual PATH + real home dir,
// read-only) — assertions only check shape, not install state.
function freshApp() {
  const { app, cleanup } = makeApp();
  return { app, cleanup };
}

async function adminGetOk(path: string, peer = "127.0.0.1") {
  const { app, cleanup } = freshApp();
  try { return await adminGet(app, path, peer); } finally { cleanup(); }
}

async function adminJsonOk(path: string, method: string, body?: unknown, peer = "127.0.0.1") {
  const { app, cleanup } = freshApp();
  try { return await adminJson(app, path, method, body, peer); } finally { cleanup(); }
}

describe("cli-tools all-statuses", () => {
  test("returns a status entry per registered tool", async () => {
    const res = await adminGetOk("/api/admin/cli-tools/all-statuses");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "claude", "cline", "codex", "copilot", "cowork", "deepseek-tui", "devin",
      "droid", "grok-build", "hermes", "jcode", "kilo", "openclaw", "opencode",
    ]);
    expect(typeof body.claude.installed).toBe("boolean");
  });

  test("uninstalled tool reports installed false", async () => {
    const noDeps = fakeFs({}, []);
    const result = await TOOL_HANDLERS.claude!.get(noDeps) as { installed: boolean; message: string };
    expect(result.installed).toBe(false);
    expect(result.message).toContain("not installed");
  });
});

describe("claude settings", () => {
  test("apply writes env and reports configured on next get", async () => {
    const fs = fakeFs({}, ["claude"]);
    const apply = await TOOL_HANDLERS.claude!.apply!({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20129", ANTHROPIC_AUTH_TOKEN: "sk-test" } }, fs);
    expect(apply).toEqual({ success: true, message: expect.stringContaining("updated") });
    const written = JSON.parse(fs.files.get(`${process.env.HOME}/.claude/settings.json`)!);
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:20129/v1");
    expect(written.hasCompletedOnboarding).toBe(true);
    const status = await TOOL_HANDLERS.claude!.get(fs) as { installed: boolean; has9Router: boolean };
    expect(status.installed).toBe(true);
    expect(status.has9Router).toBe(true);
  });

  test("apply rejects non-object env", async () => {
    const result = await TOOL_HANDLERS.claude!.apply!({ env: "nope" }, fakeFs());
    expect(result).toEqual({ error: "Invalid env object" });
  });

  test("reset removes 9router env keys but keeps unrelated settings", async () => {
    const settingsPath = `${process.env.HOME}/.claude/settings.json`;
    const fs = fakeFs({
      [settingsPath]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://x/v1", KEEP_ME: "1" }, other: true }),
    }, ["claude"]);
    await TOOL_HANDLERS.claude!.reset!(fs);
    const written = JSON.parse(fs.files.get(settingsPath)!);
    expect(written.env).toEqual({ KEEP_ME: "1" });
    expect(written.other).toBe(true);
  });
});

describe("codex settings", () => {
  test("apply writes 9router provider and model; reset removes them", async () => {
    const configPath = `${process.env.HOME}/.codex/config.toml`;
    const fs = fakeFs({}, ["codex"]);
    const apply = await TOOL_HANDLERS.codex!.apply!({ baseUrl: "http://127.0.0.1:20129", apiKey: "sk-key", model: "cx/gpt-5" }, fs);
    expect((apply as { success: boolean }).success).toBe(true);
    const toml = fs.files.get(configPath)!;
    expect(toml).toContain(`model_provider = "fast-9router"`);
    expect(toml).toContain("[model_providers.fast-9router]");
    expect(toml).toContain(`wire_api = "responses"`);
    expect(toml).toContain("default_subagent_model");
    const status = await TOOL_HANDLERS.codex!.get(fs) as { has9Router: boolean };
    expect(status.has9Router).toBe(true);
    await TOOL_HANDLERS.codex!.reset!(fs);
    const after = fs.files.get(configPath)!;
    expect(after).not.toContain("fast-9router");
    const statusAfter = await TOOL_HANDLERS.codex!.get(fs) as { has9Router: boolean };
    expect(statusAfter.has9Router).toBe(false);
  });

  test("apply requires baseUrl, apiKey, model", async () => {
    const result = await TOOL_HANDLERS.codex!.apply!({ baseUrl: "http://x" }, fakeFs());
    expect(result).toEqual({ error: "baseUrl, apiKey and model are required" });
  });
});

describe("opencode settings", () => {
  test("multi-model apply, active model, single-model delete", async () => {
    const configPath = `${process.env.HOME}/.config/opencode/opencode.json`;
    const fs = fakeFs({}, ["opencode"]);
    await TOOL_HANDLERS.opencode!.apply!({ baseUrl: "http://127.0.0.1:20129", apiKey: "sk-k", models: ["m1", "m2"], activeModel: "m2" }, fs);
    const config = JSON.parse(fs.files.get(configPath)!);
    expect(Object.keys(config.provider["fast-9router"].models).sort()).toEqual(["m1", "m2"]);
    expect(config.model).toBe("fast-9router/m2");
    expect(config.agent.explorer.model).toBe("fast-9router/m1");
    const status = await TOOL_HANDLERS.opencode!.get(fs) as { opencode: { models: string[]; activeModel: string | null } };
    expect(status.opencode.models.sort()).toEqual(["m1", "m2"]);
    expect(status.opencode.activeModel).toBe("m2");
    await TOOL_HANDLERS.opencode!.resetModel!("m2", fs);
    const after = JSON.parse(fs.files.get(configPath)!);
    expect(Object.keys(after.provider["fast-9router"].models)).toEqual(["m1"]);
    expect(after.model).toBe("fast-9router/m1");
  });
});

describe("droid settings", () => {
  test("apply creates customModels with active reorder", async () => {
    const settingsPath = `${process.env.HOME}/.factory/settings.json`;
    const fs = fakeFs({}, ["droid"]);
    await TOOL_HANDLERS.droid!.apply!({ baseUrl: "http://127.0.0.1:20129", apiKey: "sk-k", models: ["a", "b"], activeModel: "b" }, fs);
    const settings = JSON.parse(fs.files.get(settingsPath)!);
    expect(settings.customModels).toHaveLength(2);
    expect(settings.customModels[0].model).toBe("b");
    expect(settings.customModels[0].id).toContain("custom:fast-9router");
    const status = await TOOL_HANDLERS.droid!.get(fs) as { has9Router: boolean };
    expect(status.has9Router).toBe(true);
  });
});

describe("cline settings", () => {
  test("apply strips /v1 and reset restores cline provider", async () => {
    const statePath = `${process.env.HOME}/.cline/data/globalState.json`;
    const fs = fakeFs({}, ["cline"]);
    await TOOL_HANDLERS.cline!.apply!({ baseUrl: "http://127.0.0.1:20129/v1", apiKey: "sk-k", model: "m" }, fs);
    const state = JSON.parse(fs.files.get(statePath)!);
    expect(state.openAiBaseUrl).toBe("http://127.0.0.1:20129");
    expect(state.actModeApiProvider).toBe("openai");
    await TOOL_HANDLERS.cline!.reset!(fs);
    const after = JSON.parse(fs.files.get(statePath)!);
    expect(after.actModeApiProvider).toBe("cline");
    expect(after.openAiBaseUrl).toBeUndefined();
  });
});

describe("grok settings", () => {
  test("apply preserves unrelated TOML; reset restores default", async () => {
    const configPath = `${process.env.HOME}/.grok/config.toml`;
    const fs = fakeFs({
      [configPath]: `[models]\ndefault = "grok-build"\n\n[other]\nkey = "value"\n`,
    }, ["grok"]);
    await TOOL_HANDLERS["grok-build"]!.apply!({ baseUrl: "http://127.0.0.1:20129", apiKey: "sk-k", model: "m", contextWindow: 200000 }, fs);
    const applied = fs.files.get(configPath)!;
    expect(applied).toContain("[model.9router]");
    expect(applied).toContain(`default = "9router"`);
    expect(applied).toContain("[other]");
    expect(applied).toContain("key = \"value\"");
    expect(applied).toContain("# 9router-prev-default");
    await TOOL_HANDLERS["grok-build"]!.reset!(fs);
    const reset = fs.files.get(configPath)!;
    expect(reset).not.toContain("[model.9router]");
    expect(reset).toContain(`default = "grok-build"`);
    expect(reset).toContain("[other]");
  });
});

describe("jcode settings", () => {
  test("apply writes provider TOML and env file", async () => {
    const configPath = `${process.env.HOME}/.jcode/config.toml`;
    const envPath = `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/jcode/provider-9router.env`;
    const fs = fakeFs({}, ["jcode"]);
    await TOOL_HANDLERS.jcode!.apply!({ baseUrl: "http://127.0.0.1:20129", apiKey: "sk-k", models: ["m"] }, fs);
    expect(fs.files.get(configPath)!).toContain(`[providers.9router]`);
    expect(fs.files.get(envPath)!).toContain(`JCODE_9ROUTER_API_KEY="sk-k"`);
    const status = await TOOL_HANDLERS.jcode!.get(fs) as { has9Router: boolean };
    expect(status.has9Router).toBe(true);
  });
});

describe("copilot settings", () => {
  test("apply replaces existing 9Router entry", async () => {
    const configPath = process.platform === "darwin"
      ? `${process.env.HOME}/Library/Application Support/Code/User/chatLanguageModels.json`
      : `${process.env.HOME}/.config/Code/User/chatLanguageModels.json`;
    const fs = fakeFs({
      [configPath]: JSON.stringify([{ name: "Other" }, { name: "9Router", apiKey: "old", models: [] }]),
    }, []);
    await TOOL_HANDLERS.copilot!.apply!({ baseUrl: "http://127.0.0.1:20129", models: ["m1", "m2"] }, fs);
    const config = JSON.parse(fs.files.get(configPath)!);
    expect(config).toHaveLength(2);
    const entry = config.find((e: { name: string }) => e.name === "9Router");
    expect(entry.models.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);
    expect(entry.models[0].url).toContain("/chat/completions");
    await TOOL_HANDLERS.copilot!.reset!(fs);
    const after = JSON.parse(fs.files.get(configPath)!);
    expect(after).toEqual([{ name: "Other" }]);
  });
});

describe("hermes settings", () => {
  test("apply upserts model block preserving other YAML; reset removes it", async () => {
    const configPath = `${process.env.HOME}/.hermes/config.yaml`;
    const fs = fakeFs({ [configPath]: "logging:\n  level: info\n" }, ["hermes"]);
    await TOOL_HANDLERS.hermes!.apply!({ baseUrl: "http://127.0.0.1:20129", apiKey: "sk-k", model: "m" }, fs);
    const applied = fs.files.get(configPath)!;
    expect(applied).toContain(`default: "m"`);
    expect(applied).toContain(`provider: "custom"`);
    expect(applied).toContain("logging:");
    const status = await TOOL_HANDLERS.hermes!.get(fs) as { has9Router: boolean };
    expect(status.has9Router).toBe(true);
    await TOOL_HANDLERS.hermes!.reset!(fs);
    expect(fs.files.get(configPath)!).not.toContain(`default: "m"`);
  });
});

describe("kilo and deepseek settings", () => {
  test("kilo apply/reset round-trips auth entry", async () => {
    const authPath = `${process.env.HOME}/.local/share/kilo/auth.json`;
    const fs = fakeFs({}, ["kilo"]);
    await TOOL_HANDLERS.kilo!.apply!({ baseUrl: "http://127.0.0.1:20129", apiKey: "sk-k", model: "m" }, fs);
    const auth = JSON.parse(fs.files.get(authPath)!);
    expect(auth["openai-compatible"].baseUrl).toBe("http://127.0.0.1:20129/v1");
    await TOOL_HANDLERS.kilo!.reset!(fs);
    expect(JSON.parse(fs.files.get(authPath)!)["openai-compatible"]).toBeUndefined();
  });

  test("deepseek apply overwrites config; reset restores deepseek default", async () => {
    const configPath = `${process.env.HOME}/.deepseek/config.toml`;
    const fs = fakeFs({}, ["deepseek"]);
    await TOOL_HANDLERS["deepseek-tui"]!.apply!({ baseUrl: "http://127.0.0.1:20129", apiKey: "sk-k", model: "m" }, fs);
    expect(fs.files.get(configPath)!).toContain("[providers.openai]");
    await TOOL_HANDLERS["deepseek-tui"]!.reset!(fs);
    expect(fs.files.get(configPath)!).toBe(`provider = "deepseek"\n`);
  });
});

describe("cli-tools HTTP routes", () => {
  const PATH = "/api/admin/cli-tools";

  test("unknown tool 404s", async () => {
    const res = await adminGetOk(`${PATH}/nope-settings`);
    expect(res.status).toBe(404);
  });

  test("devin GET is status-only (no apply route)", async () => {
    const res = await adminGetOk(`${PATH}/devin-settings`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.installed).toBe("boolean");
    const post = await adminJsonOk(`${PATH}/devin-settings`, "POST", {});
    expect(post.status).toBe(404);
  });

  test("apply endpoint rejects invalid body with 400", async () => {
    const res = await adminJsonOk(`${PATH}/codex-settings`, "POST", { baseUrl: "http://x" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("required");
  });

  test("non-loopback peer is rejected", async () => {
    const res = await adminGetOk(`${PATH}/all-statuses`, "192.168.1.5");
    expect(res.status).toBe(403);
  });
});
