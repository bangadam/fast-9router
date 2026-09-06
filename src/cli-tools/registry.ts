// CLI tool settings registry: id → get/apply/reset handlers.
// Mirrors 9router's /api/cli-tools/* route set (14 status-backed tools).

import type { ToolDeps } from "./core.ts";
import { claudeGet, claudeApply, claudeReset } from "./claude.ts";
import { codexGet, codexApply, codexReset } from "./codex.ts";
import { opencodeGet, opencodeApply, opencodeClearActive, opencodeReset } from "./opencode.ts";
import { droidGet, droidApply, droidReset } from "./droid.ts";
import { openclawGet, openclawApply, openclawReset } from "./openclaw.ts";
import { hermesGet, hermesApply, hermesReset } from "./hermes.ts";
import { clineGet, clineApply, clineReset } from "./cline.ts";
import { kiloGet, kiloApply, kiloReset } from "./kilo.ts";
import { copilotGet, copilotApply, copilotReset } from "./copilot.ts";
import { deepseekGet, deepseekApply, deepseekReset } from "./deepseek.ts";
import { jcodeGet, jcodeApply, jcodeReset } from "./jcode.ts";
import { grokGet, grokApply, grokReset } from "./grok.ts";
import { devinGet } from "./devin.ts";
import { coworkGet, coworkApply, coworkReset } from "./cowork.ts";

export type ToolApply = (body: Record<string, unknown>, deps?: ToolDeps) => Promise<unknown>;
export type ToolHandler = {
  get: (deps?: ToolDeps) => Promise<unknown>;
  apply?: ToolApply;
  reset?: (deps?: ToolDeps) => Promise<unknown>;
  patch?: (body: Record<string, unknown>, deps?: ToolDeps) => Promise<unknown>;
  resetModel?: (model: string | null, deps?: ToolDeps) => Promise<unknown>;
};

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  claude: { get: claudeGet, apply: claudeApply, reset: claudeReset },
  codex: { get: codexGet, apply: codexApply, reset: codexReset },
  opencode: { get: opencodeGet, apply: opencodeApply, patch: opencodeClearActive, resetModel: opencodeReset, reset: (deps) => opencodeReset(null, deps) },
  droid: { get: droidGet, apply: droidApply, reset: droidReset },
  openclaw: { get: openclawGet, apply: openclawApply, reset: openclawReset },
  hermes: { get: hermesGet, apply: hermesApply, reset: hermesReset },
  cowork: { get: coworkGet, apply: coworkApply, reset: coworkReset },
  copilot: { get: copilotGet, apply: copilotApply, reset: copilotReset },
  cline: { get: clineGet, apply: clineApply, reset: clineReset },
  kilo: { get: kiloGet, apply: kiloApply, reset: kiloReset },
  "deepseek-tui": { get: deepseekGet, apply: deepseekApply, reset: deepseekReset },
  jcode: { get: jcodeGet, apply: jcodeApply, reset: jcodeReset },
  "grok-build": { get: grokGet, apply: grokApply, reset: grokReset },
  devin: { get: devinGet },
};

export const STATUS_TOOL_IDS = Object.keys(TOOL_HANDLERS);

export function isApplyError(result: unknown): result is { error: string } {
  return typeof result === "object" && result !== null && "error" in result && typeof (result as { error: unknown }).error === "string";
}
