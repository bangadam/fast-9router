// Incremental SSE byte-stream plumbing. Pure Web Streams; no buffering of the
// whole stream — frames are parsed as bytes arrive.

export interface SseFrame {
  event?: string;
  data: string;
}

const encoder = new TextEncoder();

/** Serialize one SSE frame. */
export function sseEncode(frame: SseFrame): Uint8Array {
  let out = "";
  if (frame.event !== undefined) out += `event: ${frame.event}\n`;
  for (const line of frame.data.split("\n")) out += `data: ${line}\n`;
  out += "\n";
  return encoder.encode(out);
}

/**
 * Incremental SSE line parser. push() bytes-as-text as they arrive; drain()
 * yields complete frames. Handles CRLF, multi-line data, and comment lines.
 */
export class SseParser {
  private buf = "";

  push(chunk: string): void {
    this.buf += chunk;
  }

  drain(): SseFrame[] {
    const frames: SseFrame[] = [];
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m || m.index === undefined) break;
      const rawEvent = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);

      let event: string | undefined;
      const dataLines: string[] = [];
      let sawData = false;
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith(":")) continue; // comment / keep-alive
        if (line.startsWith("data:")) {
          sawData = true;
          dataLines.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("event:")) {
          event = line.slice(6).replace(/^ /, "");
        }
      }
      if (sawData) frames.push({ event, data: dataLines.join("\n") });
    }
    return frames;
  }

  /** Flush a trailing frame when the stream ends mid-frame (no blank line). */
  flushTrailing(): SseFrame[] {
    const rest = this.buf.replace(/\r?\n$/, "");
    this.buf = "";
    if (!rest.trim()) return [];
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of rest.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
    }
    return dataLines.length ? [{ event, data: dataLines.join("\n") }] : [];
  }
}

export interface EventStream {
  transform: TransformStream<Uint8Array, Uint8Array>;
  /** Emit a JSON event (data = JSON.stringify(data)). */
  emit: (data: unknown, event?: string) => void;
  /** Emit a raw data line (e.g. "[DONE]"). */
  emitRaw: (data: string) => void;
}

/**
 * Build the streaming seam: an identity-ish TransformStream whose transform
 * callback parses upstream SSE frames and hands each to onEvent; onEvent (and
 * onEnd) write client-format frames back through the same controller. Fully
 * incremental — a chunk in produces chunks out.
 */
export function makeEventStream(
  onEvent: (ev: { event?: string; data: string }) => void,
  onEnd: () => void,
): EventStream {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  let controller: TransformStreamDefaultController<Uint8Array> | null = null;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(c) {
      controller = c;
    },
    transform(chunk) {
      parser.push(decoder.decode(chunk, { stream: true }));
      for (const frame of parser.drain()) onEvent(frame);
    },
    flush() {
      parser.push(decoder.decode());
      for (const frame of parser.drain()) onEvent(frame);
      for (const frame of parser.flushTrailing()) onEvent(frame);
      onEnd();
    },
  });

  return {
    transform,
    emit: (data, event) => {
      controller?.enqueue(
        sseEncode({ event, data: JSON.stringify(data) }),
      );
    },
    emitRaw: (data) => {
      controller?.enqueue(sseEncode({ data }));
    },
  };
}

export function parseSseData(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export { encoder as sseEncoder };
