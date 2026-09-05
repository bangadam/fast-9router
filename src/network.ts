const REDIRECT_STATUSES: Record<number, true> = {
  301: true,
  302: true,
  303: true,
  307: true,
  308: true,
};

function blockedRedirectResponse(message: string): Response {
  return Response.json(
    { error: { message, type: "security_error" } },
    { status: 421 },
  );
}

/**
 * Fetch authenticated upstreams while following redirects only inside the
 * original origin. This prevents custom credential headers such as x-api-key
 * from reaching an attacker-controlled redirect target.
 */
export async function fetchAuthenticated(
  input: string | URL,
  init: RequestInit,
  maxRedirects = 3,
): Promise<Response> {
  let current = new URL(input);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);
  for (let redirectCount = 0; ; redirectCount++) {
    const response = await fetch(current, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES[response.status]) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (!location) return blockedRedirectResponse("authenticated upstream redirect omitted its location");
    if (redirectCount >= maxRedirects) {
      return blockedRedirectResponse("authenticated upstream exceeded the redirect limit");
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return blockedRedirectResponse("authenticated upstream returned an invalid redirect");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      return blockedRedirectResponse("authenticated upstream redirect changed protocol");
    }
    if (next.username || next.password || next.origin !== current.origin) {
      return blockedRedirectResponse("authenticated upstream redirect crossed origin");
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
      headers.delete("content-length");
    }
    current = next;
  }
}
/** True when the peer address is loopback: 127.0.0.0/8, ::1, ::ffff:127.x.x.x. */
export function isLoopbackAddress(address: string): boolean {
  let a = address.trim().toLowerCase();
  // strip port from "[::1]:1234" or "127.0.0.1:1234"
  if (a.startsWith("[")) {
    const end = a.indexOf("]");
    if (end === -1) return false;
    a = a.slice(1, end);
  } else {
    const colon = a.lastIndexOf(":");
    // avoid mangling bare IPv6; only strip when there are exactly one colon
    if (colon !== -1 && a.indexOf(":") === a.lastIndexOf(":")) a = a.slice(0, colon);
  }
  if (a === "::1") return true;
  const v4 = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (octets.some((o) => o > 255)) return false;
    return octets[0] === 127;
  }
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    return mapped[1]!.startsWith("127.");
  }
  return false;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || isLoopbackAddress(normalized);
}

export function isValidGatewayKey(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length >= 8;
}

export function canonicalBaseUrl(raw: string): string {
  return new URL(raw.trim()).toString().replace(/\/+$/, "");
}
