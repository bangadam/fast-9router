// Codex upstream transport details that do not depend on the translator
// layer: private endpoint constants, identity headers, image prefetch with
// SSRF protection, and safe (no-credential-redirect) fetch.
//
// Derived from 9Router (https://github.com/decolua/9router),
// MIT License, Copyright (c) 2024-2026 decolua and contributors.

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/** Private ChatGPT backend endpoint for Codex (deprecated upstream; PRD risk). */
export function codexEndpoint(): string {
  return process.env.FAST9R_CODEX_ENDPOINT || "https://chatgpt.com/backend-api/codex/responses";
}

export const CODEX_HEADERS = {
  originator: "codex_cli_rs",
  userAgent: "codex_cli_rs/0.136.0",
} as const;

// ---------------------------------------------------------------------------
// Identity headers
// ---------------------------------------------------------------------------

export interface CodexIdentity {
  sessionId: string;
  chatgptAccountId?: string;
}

/**
 * Identity headers bound to the selected connection's account/workspace so
 * credentials are never mixed between accounts (PRD story 10).
 */
export function codexIdentityHeaders(identity: CodexIdentity): Record<string, string> {
  const headers: Record<string, string> = {
    originator: CODEX_HEADERS.originator,
    "User-Agent": CODEX_HEADERS.userAgent,
    session_id: identity.sessionId,
  };
  if (identity.chatgptAccountId) {
    headers["ChatGPT-Account-ID"] = identity.chatgptAccountId;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Image prefetch (SSRF-guarded)
// ---------------------------------------------------------------------------

export const IMAGE_PREFETCH = {
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 3,
} as const;

/** Hostnames allowed without public-IP checks (local self-hosting is intentional). */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "[::1]";
}

export type HostResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const systemResolver: HostResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve a hostname to every address it may hit. Empty, failed, or mixed
 * public/private answers fail closed. Literal localhost is the documented
 * explicit local trust mode.
 */
export async function hostnameIsPrivate(
  hostname: string,
  resolve: HostResolver = systemResolver,
): Promise<boolean> {
  if (isLocalHost(hostname)) return false;
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) return !isPublicIp(bare);
  try {
    const results = await resolve(bare);
    return results.length === 0 || results.some((result) => !isPublicIp(result.address));
  } catch {
    return true;
  }
}

function isPublicIp(address: string): boolean {
  const bare = address.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return isPublicIPv4(bare);
  if (family === 6) return isPublicIPv6(bare);
  return false;
}

function isPublicIPv4(ip: string): boolean {
  const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return false;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return false;
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fec") || lower.startsWith("fed") || lower.startsWith("fee") || lower.startsWith("fef")) return false;
  if (lower.startsWith("ff") || lower.startsWith("2001:db8:")) return false;
  if (lower.startsWith("::ffff:")) return isPublicIPv4(lower.slice(7));
  return true;
}

export interface PrefetchResult {
  /** data: URI when the fetch succeeded within all limits, else the original URL. */
  dataUri?: string;
  error?: string;
}

/**
 * Inline a remote image URL as a data URI.
 *
 * Trust mode (documented): the router fetches arbitrary remote image URLs
 * supplied in user payloads, so this guard is mandatory —
 *   - only http(s) URLs;
 *   - 5MB size cap (streamed abort, not buffered past the limit);
 *   - 15s timeout, at most 3 redirects (manual, same-origin credential rule);
 *   - response content-type must be image/*;
 *   - non-public IP ranges (RFC1918, loopback, link-local, CGNAT, multicast,
 *     unique-local IPv6) are blocked BEFORE connecting, unless the host is
 *     literally `localhost` — a locally self-hosted image server is an
 *     intentional, explicit configuration.
 */
export async function prefetchImageAsDataUri(
  url: string,
  signal?: AbortSignal,
  resolve: HostResolver = systemResolver,
): Promise<PrefetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "invalid image URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "image URL must be http(s)" };
  }
  if (await hostnameIsPrivate(parsed.hostname, resolve)) {
    return { error: "image URL host is not a public address" };
  }

  let current = parsed;
  const timeoutSignal = AbortSignal.any?.([signal, AbortSignal.timeout(IMAGE_PREFETCH.timeoutMs)].filter(Boolean) as AbortSignal[]) ??
    AbortSignal.timeout(IMAGE_PREFETCH.timeoutMs);

  for (let hop = 0; hop <= IMAGE_PREFETCH.maxRedirects; hop++) {
    let res: Response;
    try {
      res = await fetch(current, {
        signal: timeoutSignal,
        redirect: "manual",
        headers: { accept: "image/*" },
      });
    } catch (error) {
      return { error: `image fetch failed: ${(error as Error).message}` };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      res.body?.cancel().catch(() => {});
      if (!location) return { error: "image redirect without location" };
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { error: "invalid image redirect" };
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return { error: "image redirect must stay on http(s)" };
      }
      if (await hostnameIsPrivate(next.hostname, resolve)) {
        return { error: "image redirect to non-public host blocked" };
      }
      current = next;
      continue;
    }
    if (!res.ok) return { error: `image fetch failed: ${res.status}` };
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) {
      res.body?.cancel().catch(() => {});
      return { error: "image URL did not return image/* content" };
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > IMAGE_PREFETCH.maxBytes) {
      res.body?.cancel().catch(() => {});
      return { error: "image exceeds 5MB limit" };
    }
    const reader = res.body?.getReader();
    if (!reader) return { error: "image response has no body" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value!.byteLength;
      if (total > IMAGE_PREFETCH.maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: "image exceeds 5MB limit" };
      }
      chunks.push(value!);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return { dataUri: `data:${type};base64,${btoa(bin)}` };
  }
  return { error: "too many image redirects" };
}
