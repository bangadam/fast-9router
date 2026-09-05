// Centralized logger with redaction. Every log line passes through the
// redactor — no other module constructs raw console output.
//
// Default logging records: request ID, endpoint, target provider and model,
// non-secret connection ID, latency, status, and normalized usage. Body
// logging is unavailable rather than hidden behind a toggle.

import type { LogLevel } from "./config.ts";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Credential-bearing names are redacted. Usage metrics deliberately use
// plural `*Tokens`; they are telemetry, not authentication material.
const EXACT_SECRET_KEYS: Record<string, true> = {
  authorization: true,
  apikey: true,
  xapikey: true,
  anthropickey: true,
  key: true,
  bearer: true,
  cookie: true,
  setcookie: true,
};

const SAFE_IDENTIFIER_KEYS: Record<string, true> = {
  requestid: true,
  provider: true,
  model: true,
  endpoint: true,
};

// Long high-entropy-looking strings (bare tokens in free text) are masked:
// length >= 20 with letters+digits and no spaces.
const LONG_SECRET = /[A-Za-z0-9_\-\.]{20,}/g;

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function looksSecretKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (normalized !== "tokens" && normalized.endsWith("tokens")) return false;
  if (EXACT_SECRET_KEYS[normalized]) return true;
  if (normalized.endsWith("token")) return true;
  return /secret|password|credential|session/.test(normalized);
}

/**
 * Redact secret values from arbitrary JSON-serializable data. Keys that look
 * like credential names have their value replaced with "[REDACTED]". Long
 * opaque strings inside other values are replaced the same way. Returns a new
 * structure; the input is never mutated.
 */
export function redact(value: unknown, depth = 0, fieldName = ""): unknown {
  if (depth > 8) return "[REDACTED:depth]";
  if (typeof value === "string") {
    if (SAFE_IDENTIFIER_KEYS[normalizedKey(fieldName)]) return value;
    if (value.length >= 20 && /^[A-Za-z0-9_\-.]+$/.test(value)) {
      return "[REDACTED]";
    }
    // Replace long token-like runs inside otherwise readable strings.
    return value.replace(LONG_SECRET, (match) => {
      // Avoid mangling normal long words: require at least one digit or dash.
      if (!/[0-9_-]/.test(match)) return match;
      return "[REDACTED]";
    });
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, fieldName));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = looksSecretKey(key) ? "[REDACTED]" : redact(item, depth + 1, key);
    }
    return out;
  }
  return value;
}

export interface LogFields {
  [key: string]: unknown;
}

export class Logger {
  constructor(readonly level: LogLevel = "info") {}

  private emit(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...redact(fields) as Record<string, unknown>,
    });
    if (level === "error") console.error(line);
    else console.log(line);
  }

  debug(msg: string, fields?: LogFields): void { this.emit("debug", msg, fields); }
  info(msg: string, fields?: LogFields): void { this.emit("info", msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.emit("warn", msg, fields); }
  error(msg: string, fields?: LogFields): void { this.emit("error", msg, fields); }

  /** Standard request-completion line per PRD: id, endpoint, provider, model, connection, latency, status, usage. */
  request(fields: {
    requestId: string;
    endpoint: string;
    provider?: string;
    model?: string;
    connectionId?: number;
    latencyMs: number;
    status: number;
    usage?: Record<string, unknown>;
  }): void {
    this.emit("info", "request", { ...fields });
  }
}
