import type { Logger } from "../log.ts";
import { readResponseTextLimited, safeUpstreamMessage, sanitizeErrorText } from "../upstream-error.ts";
import { isLoopbackHostname } from "../network.ts";

export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_CALLBACK_PATH = "/auth/callback";
const PROXY_TTL_MS = 5 * 60_000;

type CallbackServer = Bun.Server<undefined>;
let server: CallbackServer | null = null;
let targetOrigin: string | null = null;
let stopTimer: ReturnType<typeof setTimeout> | undefined;

export interface CodexCallbackProxyResult {
  ok: boolean;
  port?: number;
  error?: string;
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resultPage(success: boolean, message: string, returnUrl: string): Response {
  const title = success ? "Authentication Successful" : "Authentication Failed";
  const color = success ? "#087f5b" : "#b4232d";
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeReturnUrl = escapeHtml(`${returnUrl}/#/connections`);
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="2;url=${safeReturnUrl}"><title>${safeTitle}</title>
<style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#FDFAF6;color:#0a0a0a}.card{max-width:28rem;padding:2rem;border:1px solid #eee9e4;border-radius:14px;background:#fff;text-align:center;box-shadow:0 12px 36px -8px #0f172a1a}.mark{font-size:3rem;color:${color}}a{color:#cc5236}</style>
</head><body><main class="card"><div class="mark">${success ? "&#10003;" : "&#10007;"}</div><h1>${safeTitle}</h1><p>${safeMessage}</p><p><a href="${safeReturnUrl}">Return to Fast 9Router</a></p></main></body></html>`, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; navigate-to 'self' http://127.0.0.1:* http://localhost:*",
      "referrer-policy": "no-referrer",
    },
  });
}

export function stopCodexCallbackProxy(): void {
  clearTimeout(stopTimer);
  stopTimer = undefined;
  server?.stop(true);
  server = null;
  targetOrigin = null;
}

export async function startCodexCallbackProxy(
  appOrigin: string,
  logger?: Logger,
  port = CODEX_CALLBACK_PORT,
): Promise<CodexCallbackProxyResult> {
  let origin: string;
  try {
    const parsed = new URL(appOrigin);
    if (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
      return { ok: false, error: "OAuth callback target must be a loopback HTTP origin" };
    }
    origin = parsed.origin;
  } catch {
    return { ok: false, error: "OAuth callback target is invalid" };
  }

  if (server) {
    if (targetOrigin !== origin) return { ok: false, error: "OAuth callback proxy is already bound to another app origin" };
    clearTimeout(stopTimer);
    stopTimer = setTimeout(stopCodexCallbackProxy, PROXY_TTL_MS);
    return { ok: true, port: server.port };
  }

  try {
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== CODEX_CALLBACK_PATH) return new Response("Not found", { status: 404 });
        if (!isAllowedOrigin(request.headers.get("origin"))) return new Response("Forbidden", { status: 403 });
        try {
          const callback = await fetch(`${origin}/api/admin/oauth/codex/callback${url.search}`, {
            redirect: "manual",
          });
          const text = await readResponseTextLimited(callback).catch(() => "");
          if (!callback.ok) {
            return resultPage(false, safeUpstreamMessage(callback.status, text), origin);
          }
          return resultPage(true, "Your Codex account is connected.", origin);
        } catch (error) {
          logger?.error("codex oauth callback proxy failed", {
            error: sanitizeErrorText((error as Error).message),
          });
          return resultPage(false, "Fast 9Router could not complete the callback.", origin);
        }
      },
    });
    targetOrigin = origin;
    stopTimer = setTimeout(stopCodexCallbackProxy, PROXY_TTL_MS);
    return { ok: true, port: server.port };
  } catch (error) {
    server = null;
    targetOrigin = null;
    return {
      ok: false,
      error: `OAuth callback port ${port} is unavailable: ${sanitizeErrorText((error as Error).message)}`,
    };
  }
}
