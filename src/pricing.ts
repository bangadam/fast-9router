// Pricing mechanism ported from 9Router's MIT-licensed open-sse/providers/pricing.js.
// Rates are estimated USD per 1M tokens. Exact model match wins, then ordered patterns.

export interface ModelRate {
  input: number;
  cached: number;
  output: number;
}

const EXACT: Record<string, ModelRate> = {
  "claude-3-5-sonnet-20241022": { input: 3, cached: 1.5, output: 15 },
  "claude-haiku-4.5": { input: 0.5, cached: 0.05, output: 2.5 },
  "claude-opus-4.5": { input: 5, cached: 0.5, output: 25 },
  "claude-sonnet-4.5": { input: 3, cached: 0.3, output: 15 },
  "gpt-4-turbo": { input: 10, cached: 5, output: 30 },
  "gpt-4o": { input: 2.5, cached: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cached: 0.075, output: 0.6 },
  "gpt-4.1": { input: 2.5, cached: 1.25, output: 10 },
  "gpt-5": { input: 1.25, cached: 0.625, output: 10 },
  "gpt-5-mini": { input: 0.25, cached: 0.125, output: 2 },
  "gpt-5.1": { input: 1.25, cached: 0.625, output: 10 },
  "gpt-5.2": { input: 1.75, cached: 0.175, output: 14 },
  "gpt-5.3-codex-spark": { input: 3, cached: 0.3, output: 12 },
  "gpt-5.6-luna": { input: 1, cached: 0.1, output: 6 },
  "gpt-5.6-terra": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.6-sol": { input: 5, cached: 0.5, output: 30 },
  "o1": { input: 15, cached: 7.5, output: 60 },
  "o1-mini": { input: 3, cached: 1.5, output: 12 },
};

const PATTERNS: Array<[RegExp, ModelRate]> = [
  [/.*-codex-spark$/i, { input: 3, cached: 0.3, output: 12 }],
  [/^codex-.*|.*-codex$/i, { input: 1.75, cached: 0.175, output: 14 }],
  [/^claude-opus-/i, { input: 5, cached: 0.5, output: 25 }],
  [/^claude-sonnet-/i, { input: 3, cached: 0.3, output: 15 }],
  [/^claude-haiku-/i, { input: 1, cached: 0.1, output: 5 }],
  [/^claude-/i, { input: 3, cached: 0.3, output: 15 }],
  [/^gpt-5\.6-/i, { input: 2.5, cached: 0.25, output: 15 }],
  [/^gpt-5\.3-/i, { input: 1.75, cached: 0.175, output: 14 }],
  [/^gpt-5\.2-/i, { input: 1.75, cached: 0.175, output: 14 }],
  [/^gpt-5\.1-/i, { input: 1.25, cached: 0.625, output: 10 }],
  [/^gpt-5/i, { input: 1.25, cached: 0.625, output: 10 }],
  [/^gpt-4o-/i, { input: 0.15, cached: 0.075, output: 0.6 }],
  [/^gpt-4/i, { input: 2.5, cached: 1.25, output: 10 }],
  [/^o1-/i, { input: 3, cached: 1.5, output: 12 }],
  [/^o3-/i, { input: 10, cached: 5, output: 40 }],
  [/^o4-/i, { input: 2, cached: 1, output: 8 }],
  [/^glm-5/i, { input: 1, cached: 0.5, output: 4 }],
  [/^glm-4/i, { input: 0.75, cached: 0.375, output: 3 }],
  [/^glm-/i, { input: 0.5, cached: 0.25, output: 2 }],
];

export function rawModelId(canonical: string): string {
  const slash = canonical.indexOf("/");
  const model = slash === -1 ? canonical : canonical.slice(slash + 1);
  return model.endsWith("-review") ? model.slice(0, -"-review".length) : model;
}

export function modelRate(canonical: string): ModelRate | null {
  const model = rawModelId(canonical);
  const exact = EXACT[model];
  if (exact) return exact;
  return PATTERNS.find(([pattern]) => pattern.test(model))?.[1] ?? null;
}

export function estimateCost(
  canonical: string,
  promptTokens: number | null,
  cachedTokens: number | null,
  completionTokens: number | null,
): { inputCost: number; cachedCost: number; outputCost: number; cost: number } {
  const rate = modelRate(canonical);
  if (!rate) return { inputCost: 0, cachedCost: 0, outputCost: 0, cost: 0 };
  const cached = cachedTokens ?? 0;
  const input = Math.max(0, (promptTokens ?? 0) - cached);
  const inputCost = input * rate.input / 1_000_000;
  const cachedCost = cached * rate.cached / 1_000_000;
  const outputCost = (completionTokens ?? 0) * rate.output / 1_000_000;
  return { inputCost, cachedCost, outputCost, cost: inputCost + cachedCost + outputCost };
}
