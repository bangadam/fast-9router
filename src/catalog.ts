// Model catalog for Fast 9Router.
//
// Derived from 9Router's provider registry (open-sse/providers/registry/).
// Copyright (c) 2024-2026 decolua and contributors (MIT).
//
// The legacy anthropic.js registry entries carry empty `id` values in the
// reference repo (scrubbed before handoff), so Anthropic model IDs below are
// a curated list of official API model IDs, not recovered registry data.

export interface CatalogModel {
  id: string;
  name: string;
  /** canonical router id, e.g. `cx/gpt-5.6-sol` */
  canonical: string;
  upstreamModelId?: string;
  quotaFamily?: string;
}

export interface ProviderCatalog {
  provider: string;
  /** canonical-id prefix (reserved) */
  prefix: string;
  models: CatalogModel[];
}

export const RESERVED_PREFIXES = ["cx", "anthropic", "oa"] as const;

// Replicates legacy withCodexReviewModels: every LLM model gets a `-review`
// sibling whose upstreamModelId points at the base model and quotaFamily is
// "review". Image-kind codex models are excluded (image generation is out of
// scope).
const CODEX_LLM: ReadonlyArray<readonly [string, string]> = [
  ["gpt-5.6-sol", "GPT 5.6 Sol"],
  ["gpt-5.6-terra", "GPT 5.6 Terra"],
  ["gpt-5.6-luna", "GPT 5.6 Luna"],
  ["gpt-5.5", "GPT 5.5"],
  ["gpt-5.4", "GPT 5.4"],
  ["gpt-5.4-mini", "GPT 5.4 Mini"],
  ["gpt-5.3-codex-spark", "GPT 5.3 Codex Spark"],
];

const codexModels: CatalogModel[] = CODEX_LLM.flatMap(([id, name]) => [
  { id, name, canonical: `cx/${id}` },
  {
    id: `${id}-review`,
    name: `${name} Review`,
    canonical: `cx/${id}-review`,
    upstreamModelId: id,
    quotaFamily: "review",
  },
]);

export const CODEX_CATALOG: ProviderCatalog = {
  provider: "codex",
  prefix: "cx",
  models: codexModels,
};
// Official Anthropic Messages API model IDs (active + common legacy, per
// Anthropic docs September 2026; the legacy 9Router registry copy shipped
// empty ids).
const ANTHROPIC_LLM = [
  ["claude-opus-4-5", "Claude Opus 4.5"],
  ["claude-sonnet-4-5", "Claude Sonnet 4.5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
  ["claude-3-7-sonnet-20250219", "Claude Sonnet 3.7"],
  ["claude-3-5-sonnet-20241022", "Claude Sonnet 3.5"],
  ["claude-3-5-haiku-20241022", "Claude Haiku 3.5"],
  ["claude-3-haiku-20240307", "Claude Haiku 3"],
] as const;

export const ANTHROPIC_CATALOG: ProviderCatalog = {
  provider: "anthropic",
  prefix: "anthropic",
  models: ANTHROPIC_LLM.map(([id, name]) => ({
    id,
    name,
    canonical: `anthropic/${id}`,
  })),
};

export const OPENAI_CATALOG: ProviderCatalog = {
  provider: "openai",
  prefix: "oa",
  // LLM entries only: legacy openai.js embedding/tts/stt/image kinds excluded.
  models: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.2",
    "gpt-5.1",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "o3",
    "o3-mini",
    "o3-pro",
    "o4-mini",
    "o1",
    "o1-mini",
  ].map((id) => ({ id, name: id, canonical: `oa/${id}` })),
};

export const CATALOGS: ProviderCatalog[] = [
  CODEX_CATALOG,
  ANTHROPIC_CATALOG,
  OPENAI_CATALOG,
];

/** Default base URL for the [OI] preset (official OpenAI, [OI]-compatible adapter). */
export const OPENAI_PRESET_BASE_URL = "https://api.openai.com/v1";

export function catalogModelForCanonical(
  canonical: string,
): CatalogModel | undefined {
  for (const c of CATALOGS) {
    const m = c.models.find((m) => m.canonical === canonical);
    if (m) return m;
  }
  return undefined;
}
