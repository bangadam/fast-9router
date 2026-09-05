// Benchmark runner: cold start, idle RSS, dependency count, artifact size.
// Usage: BENCH_SAMPLES=<n> bun scripts/benchmark.ts
// Results print to stdout (JSON + table) and persist to benchmark-result.json.

import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pkg from "../package.json";

const ROOT = join(import.meta.dir, "..");
const SAMPLES = Math.max(1, Number(process.env.BENCH_SAMPLES) || 5);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const { createServer } = require("node:net");
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => {
    const port = (srv.address() as { port: number }).port;
    srv.close(() => resolve(port));
  });
  srv.on("error", reject);
  return promise;
}

async function rssKb(pid: number): Promise<number> {
  const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return Number(out.trim());
}

async function benchColdStart(): Promise<{ coldStartMs: number[]; idleRssKb: number[] }> {
  const coldStartMs: number[] = [];
  const idleRssKb: number[] = [];

  for (let i = 0; i < SAMPLES; i++) {
    const port = await freePort();
    const dataDir = mkdtempSync(join(tmpdir(), "fast9r-bench-"));
    const t0 = performance.now();
    const proc = Bun.spawn(["bun", "run", join(ROOT, "src/server.ts")], {
      cwd: ROOT,
      env: { ...process.env, FAST9R_DATA_DIR: dataDir, FAST9R_PORT: String(port) },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      // Poll until /v1/models answers.
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
          if (res.ok) break;
        } catch { /* not up yet */ }
        if (proc.exitCode !== null) throw new Error(`server exited early with code ${proc.exitCode}`);
        await Bun.sleep(5);
      }
      coldStartMs.push(Math.round(performance.now() - t0));
      idleRssKb.push(await rssKb(proc.pid));
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  }

  return { coldStartMs, idleRssKb };
}

function dirSizeBytes(path: string): number {
  let total = 0;
  let entries: string[];
  try { entries = readdirSync(path); } catch { return 0; }
  for (const name of entries) {
    const full = join(path, name);
    const st = statSync(full);
    total += st.isDirectory() ? dirSizeBytes(full) : st.size;
  }
  return total;
}

function dependencyCounts() {
  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  return { dependencies: deps.length, devDependencies: devDeps.length, runtime: deps.length };
}

function artifactSize() {
  // Compiled executable if present (owner runs `bun build --compile`), else source tree.
  for (const name of ["fast-9router", "fast-9router.exe"]) {
    const p = join(ROOT, name);
    try { return { kind: "compiled executable", path: name, bytes: statSync(p).size }; } catch { /* not built */ }
  }
  const src = dirSizeBytes(join(ROOT, "src"));
  const pub = dirSizeBytes(join(ROOT, "public"));
  const nmo = dirSizeBytes(join(ROOT, "node_modules"));
  return { kind: "source tree (src/ + public/ + node_modules)", bytes: src + pub + nmo, breakdown: { src, public: pub, node_modules: nmo } };
}

const { coldStartMs, idleRssKb } = await benchColdStart();
const deps = dependencyCounts();
const artifact = artifactSize();

const result = {
  timestamp: new Date().toISOString(),
  machine: { platform: process.platform, arch: process.arch },
  runtime: { name: "bun", version: Bun.version },
  command: "bun scripts/benchmark.ts",
  samples: SAMPLES,
  coldStartMs: { values: coldStartMs, median: median(coldStartMs) },
  idleRssKb: { values: idleRssKb, median: median(idleRssKb) },
  dependencies: deps,
  artifactSize: artifact,
};

writeFileSync(join(ROOT, "benchmark-result.json"), JSON.stringify(result, null, 2) + "\n");

console.log(JSON.stringify(result, null, 2));
console.log(`
Benchmark summary (fast-9router)
  machine        ${result.machine.platform}/${result.machine.arch}
  runtime        bun ${Bun.version}
  samples        ${SAMPLES}
  ┌────────────────┬───────────────────────────────────┐
  │ metric         │ median                            │
  ├────────────────┼───────────────────────────────────┤
  │ cold start     │ ${median(coldStartMs)} ms                            │
  │ idle RSS       │ ${median(idleRssKb)} KB                            │
  │ dependencies   │ ${deps.dependencies} runtime (bun executable not counted)        │
  │ artifact size  │ ${(artifact.bytes / 1024 / 1024).toFixed(1)} MB (${artifact.kind}) │
  └────────────────┴───────────────────────────────────┘
  cold start samples: ${coldStartMs.join(", ")} ms
  idle RSS samples:   ${idleRssKb.join(", ")} KB
  written to benchmark-result.json
`);
