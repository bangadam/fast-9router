// Dashboard password authentication: Argon2id password hashing via
// Bun.password, 24-hour HttpOnly session cookies backed by SHA-256 token
// hashes in SQLite, and bounded in-memory progressive lockout per trusted
// peer. Never logs password, cookie, token, or hash values.
//
// Legacy default: an unset password accepts `123456` (administration remains
// loopback-only, so this is a local defense).

import { createHash, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  createDashboardSession,
  deleteAllDashboardSessions,
  deleteDashboardSession,
  getDashboardSession,
  getSettings,
  setPasswordHash,
  deleteExpiredDashboardSessions,
} from "./db.ts";

export const SESSION_COOKIE = "fast9r_session";
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
export const DEFAULT_PASSWORD = "123456";
export const MIN_PASSWORD_BYTES = 8;
export const MAX_PASSWORD_BYTES = 256;
const SESSION_TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export function verifyPasswordHash(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
}

export interface PasswordCheck {
  ok: boolean;
}

/**
 * Verify a dashboard password against `settings.passwordHash`. When the hash
 * is empty, the legacy default `123456` is accepted (constant-time compare).
 */
export async function verifyDashboardPassword(db: Database, password: string): Promise<PasswordCheck> {
  const { passwordHash } = getSettings(db);
  if (passwordHash === "") {
    return { ok: constantTimeEquals(password, DEFAULT_PASSWORD) };
  }
  try {
    return { ok: await verifyPasswordHash(password, passwordHash) };
  } catch {
    return { ok: false };
  }
}

/** Validate a new password: 8-256 UTF-8 bytes. Returns an error or null. */
export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== "string") return "new password must be a string";
  const bytes = new TextEncoder().encode(password).byteLength;
  if (bytes < MIN_PASSWORD_BYTES) return `new password must be at least ${MIN_PASSWORD_BYTES} bytes`;
  if (bytes > MAX_PASSWORD_BYTES) return `new password must be at most ${MAX_PASSWORD_BYTES} bytes`;
  return null;
}

// ---------------------------------------------------------------------------
// Progressive lockout (in-memory, keyed by trusted peer only)
// ---------------------------------------------------------------------------

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const IDLE_RESET_MS = 60 * 60 * 1000; // 1h since last fail -> auto reset
const MAX_PEERS = 1024;

interface LockEntry {
  fails: number;
  lockUntil: number;
  lockLevel: number;
  lastFailAt: number;
}

const attempts = new Map<string, LockEntry>();

function pruneLockEntries(now: number): void {
  for (const [peer, entry] of attempts) {
    if (now - entry.lastFailAt > IDLE_RESET_MS && entry.lockUntil <= now) {
      attempts.delete(peer);
    }
  }
  // Hard cap: evict the oldest idle entry when the map grows beyond MAX_PEERS.
  while (attempts.size >= MAX_PEERS) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [peer, entry] of attempts) {
      if (entry.lastFailAt < oldestAt) { oldestAt = entry.lastFailAt; oldestKey = peer; }
    }
    if (oldestKey === null) break;
    attempts.delete(oldestKey);
  }
}

export interface LockStatus {
  locked: boolean;
  retryAfterSeconds?: number;
}

export function checkLock(peer: string, now = Date.now()): LockStatus {
  const entry = attempts.get(peer);
  if (!entry || entry.lockUntil <= now) return { locked: false };
  return { locked: true, retryAfterSeconds: Math.ceil((entry.lockUntil - now) / 1000) };
}

export function recordLoginFail(peer: string, now = Date.now()): void {
  const entry = attempts.get(peer) ?? { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  entry.fails += 1;
  entry.lastFailAt = now;
  if (entry.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(entry.lockLevel, LOCK_STEPS_MS.length - 1)]!;
    entry.lockUntil = now + step;
    entry.lockLevel += 1;
    entry.fails = 0;
  }
  attempts.set(peer, entry);
  pruneLockEntries(now);
}

export function recordLoginSuccess(peer: string): void {
  attempts.delete(peer);
}

/** Test hook: clear lockout state between tests. */
export function resetLoginLimiter(): void {
  attempts.clear();
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateSessionToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES))).toString("base64url");
}

export interface ValidSession {
  expiresAt: number;
}

/**
 * Resolve the presented session cookie. An expired session row is removed
 * opportunistically. Sessions die with their authVersion so a password
 * change invalidates every browser at once.
 */
export function resolveSession(db: Database, cookieHeader: string | undefined): ValidSession | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  const token = match.slice(SESSION_COOKIE.length + 1);
  if (token === "") return null;
  const tokenHash = sha256Hex(token);
  const row = getDashboardSession(db, tokenHash);
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt <= now) {
    deleteDashboardSession(db, tokenHash);
    return null;
  }
  const { authVersion } = getSettings(db);
  if (row.authVersion !== authVersion) return null;
  return { expiresAt: row.expiresAt };
}

export function sessionExpiresAt(now = Date.now()): number {
  return now + SESSION_MAX_AGE_SECONDS * 1000;
}

/** Create a session row for a fresh token; returns the raw token once. */
export function issueSession(db: Database): { token: string; expiresAt: number } {
  const token = generateSessionToken();
  const expiresAt = sessionExpiresAt();
  createDashboardSession(db, sha256Hex(token), getSettings(db).authVersion, expiresAt);
  return { token, expiresAt };
}

export function revokeSession(db: Database, cookieHeader: string | undefined): void {
  if (!cookieHeader) return;
  const match = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return;
  const token = match.slice(SESSION_COOKIE.length + 1);
  if (token === "") return;
  deleteDashboardSession(db, sha256Hex(token));
}

export function sessionCookieHeaders(token: string, requestUrl: string): Record<string, string> {
  const secure = new URL(requestUrl).protocol === "https:";
  return {
    "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`,
  };
}

export function expiredCookieHeader(): Record<string, string> {
  return {
    "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  };
}

export function pruneExpiredSessions(db: Database): void {
  deleteExpiredDashboardSessions(db);
}

/**
 * Change the dashboard password: validate the current password, hash the new
 * one, bump authVersion (revoking every session), and create a replacement
 * 24-hour session for this response. Returns the fresh token or an error.
 */
export async function changeDashboardPassword(
  db: Database,
  currentPasswordOk: boolean,
  newPassword: string,
): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; error: string; status: number }> {
  if (!currentPasswordOk) {
    return { ok: false, error: "invalid password", status: 401 };
  }
  const validation = validateNewPassword(newPassword);
  if (validation) {
    return { ok: false, error: validation, status: 400 };
  }
  const passwordHash = await hashPassword(newPassword);
  deleteAllDashboardSessions(db);
  setPasswordHash(db, passwordHash);
  const session = issueSession(db);
  return { ok: true, token: session.token, expiresAt: session.expiresAt };
}
