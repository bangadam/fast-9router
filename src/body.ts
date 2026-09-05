export type BodyTextResult =
  | { ok: true; text: string }
  | { ok: false };

/**
 * Read a request body without ever consuming more than maxBytes. The reader is
 * cancelled immediately after the first chunk that crosses the limit.
 */
export async function readBodyTextLimited(
  request: Request,
  maxBytes: number,
): Promise<BodyTextResult> {
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body exceeds configured limit").catch(() => {});
        return { ok: false };
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return { ok: true, text: parts.join("") };
  } finally {
    reader.releaseLock();
  }
}
