// Static dashboard serving from ../public with absolute-path resolution
// (import.meta.dir), so serving works regardless of process.cwd(). Vite's
// build output uses hashed filenames; Bun.file streams assets without first
// copying the entire file into a JavaScript buffer.

import { statSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** Resolve a request path to a file inside PUBLIC_DIR; null when missing or escaping. */
function resolvePublicFile(pathname: string): string | null {
  const clean = pathname.replace(/^\/+/, "").split("?")[0]!.split("#")[0]!;
  const rel = clean === "" ? "index.html" : clean;
  const abs = join(PUBLIC_DIR, rel);
  const fromRoot = relative(PUBLIC_DIR, abs);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null;
  try {
    let target = abs;
    let stats = statSync(target);
    if (stats.isDirectory()) {
      target = join(target, "index.html");
      stats = statSync(target);
    }
    return stats.isFile() ? target : null;
  } catch {
    return null;
  }
}

/** Stream file + mime; null when unreadable (missing, dir, or escapes root). */
export function serveDashboardFile(pathname: string): Response | null {
  const abs = resolvePublicFile(pathname);
  if (abs === null) return null;
  try {
    const body = Bun.file(abs);
    const type = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
    return new Response(body, {
      status: 200,
      headers: { "content-type": type, "cache-control": "no-cache" },
    });
  } catch {
    return null;
  }
}

