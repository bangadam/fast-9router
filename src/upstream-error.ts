import { redact } from "./log.ts";

export async function readResponseTextLimited(response: Response, maxBytes = 4096): Promise<string> {
  if (!response.body || maxBytes <= 0) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let remaining = maxBytes;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const kept = chunk.value.byteLength <= remaining
        ? chunk.value
        : chunk.value.subarray(0, remaining);
      parts.push(decoder.decode(kept, { stream: true }));
      remaining -= kept.byteLength;
      if (remaining === 0) {
        await reader.cancel("upstream response exceeded diagnostic limit").catch(() => {});
        break;
      }
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}

export function sanitizeErrorText(
  message: string,
  sensitiveValues: readonly string[] = [],
): string {
  let safe = message;
  for (const value of sensitiveValues) {
    if (value === "") continue;
    safe = safe.split(value).join("[REDACTED]");
  }
  const redacted = redact(safe);
  return typeof redacted === "string" ? redacted.slice(0, 500) : "upstream request failed";
}

/** Extract a short useful message while dropping HTML and reflected secrets. */
export function safeUpstreamMessage(
  status: number,
  bodyText: string,
  sensitiveValues: readonly string[] = [],
): string {
  const text = bodyText.slice(0, 4096);
  let message: string | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = parsed.error;
      if (typeof error === "string") message = error;
      else if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
        message = error.message;
      }
    } else if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
      message = parsed.message;
    }
  } catch {
    // Non-JSON errors are normalized below.
  }
  if (message === null && /^\s*<(!doctype|html)/i.test(text)) {
    return `upstream returned ${status}`;
  }
  const normalized = (message ?? text).replace(/\s+/g, " ").trim();
  return normalized === ""
    ? `upstream returned ${status}`
    : sanitizeErrorText(normalized, sensitiveValues);
}
