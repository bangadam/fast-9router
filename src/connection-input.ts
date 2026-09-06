// Connection input validation extracted from app.ts so backup import can
// apply the exact same rules as connection CRUD.

import type { Database } from "bun:sqlite";
import { canonicalBaseUrl, isLoopbackHostname } from "./network.ts";
import { OPENAI_PRESET_BASE_URL } from "./catalog.ts";
import { listConnections, type ConnectionData, type ProviderConnectionWithCooldown } from "./db.ts";

/** Base URL rules: http(s) only, no username/password/fragment/query. */
export function validateBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return "base URL must be a string";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "base URL must be a valid absolute http(s) URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "base URL must use http or https";
  }
  if (url.username || url.password) return "base URL must not contain credentials";
  if (url.hash) return "base URL must not contain a fragment";
  if (url.search) return "base URL must not contain a query string";
  return null;
}

/** Compatible prefix syntax and upstream-consistency rules. */
export function validatePrefix(
  prefix: unknown,
  existing: readonly ProviderConnectionWithCooldown[],
  baseUrl: string,
  excludeConnectionId?: number,
): string | null {
  if (typeof prefix !== "string" || prefix === "") {
    return "prefix is required for openai-compatible connections";
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(prefix)) {
    return "prefix must be 1-32 chars of lowercase letters, digits, or dashes";
  }
  if (prefix === "cx" || prefix === "anthropic") {
    return `prefix '${prefix}' is reserved`;
  }
  const normalizedBaseUrl = canonicalBaseUrl(baseUrl);
  if (prefix === "oa" && normalizedBaseUrl !== canonicalBaseUrl(OPENAI_PRESET_BASE_URL)) {
    return "prefix 'oa' is reserved for the official [OI] endpoint";
  }
  const conflict = existing.find(
    (connection) =>
      connection.id !== excludeConnectionId &&
      connection.provider === "openai" &&
      connection.data.prefix === prefix &&
      canonicalBaseUrl(connection.data.baseUrl ?? OPENAI_PRESET_BASE_URL) !== normalizedBaseUrl,
  );
  if (conflict) return `prefix '${prefix}' is already assigned to a different upstream`;
  return null;
}

export const PROVIDER_DATA_KEYS = {
  codex: ["accessToken", "refreshToken", "idToken", "expiresAt", "accountId", "email", "planType", "models", "autoPing"],
  anthropic: ["apiKey", "baseUrl", "models", "autoPing"],
  openai: ["apiKey", "baseUrl", "prefix", "models", "autoPing"],
} as const;

/**
 * Validate a connection create/update body. `existing` enables partial
 * updates (masked-sentinel handling, provider immutability).
 */
export function validateConnectionInput(
  existing: readonly ProviderConnectionWithCooldown[],
  body: Record<string, unknown>,
  current?: ProviderConnectionWithCooldown,
): { error: string } | { data: ConnectionData; provider: string; name: string; isActive: boolean; priority: number } {
  if (current && body.provider !== undefined && body.provider !== current.provider) {
    return { error: "connection provider cannot be changed" };
  }
  const provider = body.provider ?? current?.provider;
  if (provider !== "codex" && provider !== "anthropic" && provider !== "openai") {
    return { error: "provider must be one of codex, anthropic, openai" };
  }
  const name = body.name ?? current?.name;
  if (typeof name !== "string" || name.trim() === "") return { error: "name is required" };
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    return { error: "isActive must be a boolean" };
  }
  const priority = body.priority ?? current?.priority ?? 0;
  if (typeof priority !== "number" || !Number.isSafeInteger(priority)) {
    return { error: "priority must be an integer" };
  }

  const rawDataValue = body.data;
  if (rawDataValue !== undefined && (rawDataValue === null || typeof rawDataValue !== "object" || Array.isArray(rawDataValue))) {
    return { error: "data must be a JSON object" };
  }
  const rawData = { ...((rawDataValue ?? {}) as Record<string, unknown>) };
  const allowedDataKeys = PROVIDER_DATA_KEYS[provider] as readonly string[];
  const unsupportedKey = Object.keys(rawData).find((key) => !allowedDataKeys.includes(key));
  if (unsupportedKey) {
    return { error: `unsupported ${provider} connection data field: ${unsupportedKey}` };
  }

  if (rawData.apiKey === "********") {
    if (!current?.data.apiKey) return { error: "masked API key sentinel cannot be stored" };
    delete rawData.apiKey;
  }

  const existingData = Object.fromEntries(
    Object.entries(current?.data ?? {}).filter(([key]) => allowedDataKeys.includes(key)),
  );
  const merged = { ...existingData, ...rawData } as Record<string, unknown>;
  if (rawData.apiKey === null) delete merged.apiKey;
  for (const key of ["apiKey", "accessToken", "refreshToken", "idToken", "accountId", "email", "planType"] as const) {
    if (merged[key] !== undefined && typeof merged[key] !== "string") {
      return { error: `${key} must be a string` };
    }
  }
  if (merged.expiresAt !== undefined && (typeof merged.expiresAt !== "number" || !Number.isFinite(merged.expiresAt))) {
    return { error: "expiresAt must be a finite number" };
  }
  if (merged.baseUrl !== undefined) {
    const baseUrlError = validateBaseUrl(merged.baseUrl);
    if (baseUrlError) return { error: baseUrlError };
    merged.baseUrl = canonicalBaseUrl(merged.baseUrl as string);
  }
  if (merged.models !== undefined) {
    if (!Array.isArray(merged.models) || merged.models.some((model) => typeof model !== "string" || model.trim() === "")) {
      return { error: "models must be an array of non-empty strings" };
    }
    merged.models = [...new Set(merged.models.map((model) => (model as string).trim()))];
  }
  if (merged.autoPing !== undefined && typeof merged.autoPing !== "boolean") {
    return { error: "autoPing must be a boolean" };
  }
  if (provider === "openai") {
    merged.baseUrl ??= OPENAI_PRESET_BASE_URL;
    if (typeof merged.baseUrl !== "string") return { error: "base URL must be a string" };
    const prefixError = validatePrefix(merged.prefix, existing, merged.baseUrl, current?.id);
    if (prefixError) return { error: prefixError };
  }

  const data = merged as ConnectionData;
  return {
    provider,
    name: name.trim(),
    isActive: body.isActive !== undefined ? body.isActive : (current ? current.isActive === 1 : true),
    priority,
    data,
  };
}
