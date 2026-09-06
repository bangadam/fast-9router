// Token Saver: in-process request transforms ported from 9Router.
//
// RTK (compress tool results), Caveman (terse LLM output), and Ponytail
// (minimal-code bias) are applied to the NormalizedRequest exactly once, in
// that order, before account fallback.
//
// Ported from 9Router (https://github.com/decolua/9router), MIT License.
// Caveman prompts adapted from the caveman skill
// (https://github.com/JuliusBrussee/caveman); Ponytail prompts from the
// ponytail skill (https://github.com/DietrichGebert/ponytail).

import type { Database } from "bun:sqlite";
import { getSettings, type TokenSaverLevel } from "./db.ts";
import type { Logger } from "./log.ts";
import type { NormalizedRequest } from "./translate/types.ts";

// ---------------------------------------------------------------------------
// RTK constants (mirror Rust defaults)
// ---------------------------------------------------------------------------

export const RAW_CAP = 10 * 1024 * 1024;
export const MIN_COMPRESS_SIZE = 500;
export const DETECT_WINDOW = 1024;
export const GIT_DIFF_HUNK_MAX_LINES = 100;
export const GIT_LOG_MAX_LINES = 200;
export const DEDUP_LINE_MAX = 2000;
export const GREP_PER_FILE_MAX = 10;
export const FIND_PER_DIR_MAX = 10;
export const FIND_TOTAL_DIR_MAX = 20;
export const STATUS_MAX_FILES = 10;
export const STATUS_MAX_UNTRACKED = 10;
export const LS_EXT_SUMMARY_TOP = 5;
export const LS_NOISE_DIRS = [
  "node_modules", ".git", "target", "__pycache__",
  ".next", "dist", "build", ".cache", ".turbo",
  ".vercel", ".pytest_cache", ".mypy_cache", ".tox",
  ".venv", "venv", "env",
  "coverage", ".nyc_output", ".DS_Store", "Thumbs.db",
  ".idea", ".vscode", ".vs", "*.egg-info", ".eggs",
];
export const TREE_MAX_LINES = 200;
export const SEARCH_LIST_PER_DIR_MAX = 10;
export const SEARCH_LIST_TOTAL_DIR_MAX = 20;
export const SMART_TRUNCATE_HEAD = 120;
export const SMART_TRUNCATE_TAIL = 60;
export const SMART_TRUNCATE_MIN_LINES = 250;
export const READ_NUMBERED_MIN_HIT_RATIO = 0.7;

// ---------------------------------------------------------------------------
// Filters (verbatim ports of 9router/open-sse/rtk/filters/*)
// ---------------------------------------------------------------------------

function smartTruncate(input: string): string {
  const lines = input.split("\n");
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input;
  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;
  return [...head, `... +${cut} lines truncated`, ...tail].join("\n");
}

function tree(input: string): string {
  const lines = input.split("\n");
  if (lines.length === 0) return input;
  const filtered: string[] = [];
  for (const line of lines) {
    if (line.includes("director") && line.includes("file")) continue;
    if (line.trim() === "" && filtered.length === 0) continue;
    filtered.push(line);
  }
  while (filtered.length > 0 && filtered[filtered.length - 1]!.trim() === "") {
    filtered.pop();
  }
  if (filtered.length > TREE_MAX_LINES) {
    const cut = filtered.length - TREE_MAX_LINES;
    return filtered.slice(0, TREE_MAX_LINES).join("\n") + `\n... +${cut} more lines`;
  }
  return filtered.join("\n");
}

const RE_CARGO_ERR_CONT = /^\s*(-->|\||\d+\s*\||=)/;
const DEPRECATION_KEEP = 3;

function buildOutput(input: string): string {
  const lines = input.split("\n");
  if (lines.length === 0) return input;
  const errors: string[] = [];
  const warnings: string[] = [];
  const deprecations: string[] = [];
  let summary: string | null = null;
  let compilingCount = 0;
  let downloadingCount = 0;
  let inCargoError = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inCargoError) {
      if (!trimmed) { inCargoError = false; continue; }
      if (RE_CARGO_ERR_CONT.test(line)) { errors.push(line); continue; }
      inCargoError = false;
    }
    if (!trimmed) continue;
    if (/^npm (ERR!|error)/i.test(trimmed) || /^yarn error/i.test(trimmed)) { errors.push(line); continue; }
    if (/^npm warn deprecated/i.test(trimmed)) { deprecations.push(line); continue; }
    if (/^npm warn/i.test(trimmed) || /^yarn warn/i.test(trimmed)) { warnings.push(line); continue; }
    if (/^error(\[|:)/i.test(trimmed) || trimmed.startsWith("error -->")) { errors.push(line); inCargoError = true; continue; }
    if (/^warning(\[|:)/i.test(trimmed) || trimmed.startsWith("warning -->")) { warnings.push(line); inCargoError = true; continue; }
    if (/^ERROR:/i.test(trimmed)) { errors.push(line); continue; }
    if (/^\[ERROR\]/i.test(trimmed) || /^BUILD FAILED/i.test(trimmed)) { errors.push(line); continue; }
    if (/^\[WARNING\]/i.test(trimmed)) { warnings.push(line); continue; }
    if (/^\s*Compiling\s+\S+/i.test(trimmed)) { compilingCount++; continue; }
    if (/^\s*Downloading\s+\S+/i.test(trimmed) || /^Fetching\s+/i.test(trimmed)) { downloadingCount++; continue; }
    if (
      /^(added|removed|changed|audited|installed)\s+\d+\s+package/i.test(trimmed) ||
      /^\s*Finished\s+/i.test(trimmed) ||
      /^BUILD SUCCESS/i.test(trimmed) ||
      /^\d+\s+(vulnerabilities|packages?|warnings?|errors?)/i.test(trimmed) ||
      /^Successfully (installed|built)/i.test(trimmed) ||
      /^To address .* issues/i.test(trimmed) ||
      /^Run `npm (audit|fund)`/i.test(trimmed) ||
      /packages are looking for funding/i.test(trimmed)
    ) {
      summary = summary ? `${summary}\n${line}` : line;
      continue;
    }
  }

  let out = "";
  for (const d of deprecations.slice(0, DEPRECATION_KEEP)) out += `${d}\n`;
  if (deprecations.length > DEPRECATION_KEEP) out += `... +${deprecations.length - DEPRECATION_KEEP} more deprecated packages\n`;
  if (compilingCount > 0) out += `Compiled ${compilingCount} packages\n`;
  if (downloadingCount > 0) out += `Downloaded ${downloadingCount} packages\n`;
  for (const e of errors) out += `${e}\n`;
  for (const w of warnings.slice(0, 5)) out += `${w}\n`;
  if (warnings.length > 5) out += `... +${warnings.length - 5} more warnings\n`;
  if (summary) out += `${summary}\n`;
  return out.replace(/\n+$/, "") || input;
}

function dedupLog(input: string): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let prev: string | null = null;
  let runCount = 0;
  let blankStreak = 0;
  const flushRun = () => {
    if (prev !== null && runCount > 1) out.push(`  ... (${runCount - 1} duplicate lines)`);
  };
  for (const line of lines) {
    if (line.trim() === "") {
      if (blankStreak < 1) out.push(line);
      blankStreak += 1;
      flushRun();
      prev = null;
      runCount = 0;
      continue;
    }
    blankStreak = 0;
    if (line === prev) { runCount += 1; continue; }
    flushRun();
    out.push(line);
    prev = line;
    runCount = 1;
    if (out.length >= DEDUP_LINE_MAX) {
      out.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`);
      return out.join("\n");
    }
  }
  flushRun();
  return out.join("\n");
}

function find(input: string): string {
  const lines = input.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return input;
  const byDir = new Map<string, string[]>();
  for (const path of lines) {
    const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    let dir: string;
    let basename: string;
    if (lastSep === -1) { dir = "."; basename = path; }
    else { dir = path.slice(0, lastSep) || "/"; basename = path.slice(lastSep + 1); }
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(basename);
  }
  const dirs = Array.from(byDir.keys()).sort();
  let out = `${lines.length} files in ${dirs.length} dirs:\n\n`;
  for (const dir of dirs.slice(0, FIND_TOTAL_DIR_MAX)) {
    const files = byDir.get(dir)!;
    out += `${dir.replace(/\\/g, "/")}/  (${files.length})\n`;
    for (const f of files.slice(0, FIND_PER_DIR_MAX)) out += `  ${f}\n`;
    if (files.length > FIND_PER_DIR_MAX) out += `  +${files.length - FIND_PER_DIR_MAX}\n`;
  }
  if (dirs.length > FIND_TOTAL_DIR_MAX) out += `\n+${dirs.length - FIND_TOTAL_DIR_MAX} more dirs\n`;
  return out;
}

function gitDiff(diff: string, maxLines = 500): string {
  const result: string[] = [];
  let currentFile = "";
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let hunkShown = 0;
  let hunkSkipped = 0;
  let wasTruncated = false;
  const maxHunkLines = GIT_DIFF_HUNK_MAX_LINES;
  const lines = diff.split("\n");
  outer: for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (hunkSkipped > 0) { result.push(`  ... (${hunkSkipped} lines truncated)`); wasTruncated = true; hunkSkipped = 0; }
      if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);
      const parts = line.split(" b/");
      currentFile = parts.length > 1 ? parts.slice(1).join(" b/") : "unknown";
      result.push(`\n${currentFile}`);
      added = 0;
      removed = 0;
      inHunk = false;
      hunkShown = 0;
    } else if (line.startsWith("@@")) {
      if (hunkSkipped > 0) { result.push(`  ... (${hunkSkipped} lines truncated)`); wasTruncated = true; hunkSkipped = 0; }
      inHunk = true;
      hunkShown = 0;
      result.push(`  ${line}`);
    } else if (inHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        added += 1;
        if (hunkShown < maxHunkLines) { result.push(`  ${line}`); hunkShown += 1; } else hunkSkipped += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        removed += 1;
        if (hunkShown < maxHunkLines) { result.push(`  ${line}`); hunkShown += 1; } else hunkSkipped += 1;
      } else if (hunkShown < maxHunkLines && !line.startsWith("\\")) {
        if (hunkShown > 0) { result.push(`  ${line}`); hunkShown += 1; }
      }
    }
    if (result.length >= maxLines) {
      result.push("\n... (more changes truncated)");
      wasTruncated = true;
      break outer;
    }
  }
  if (hunkSkipped > 0) { result.push(`  ... (${hunkSkipped} lines truncated)`); wasTruncated = true; }
  if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);
  if (wasTruncated) result.push("[full diff: rtk git diff --no-compact]");
  return result.join("\n");
}

function gitLog(text: string, maxLines = GIT_LOG_MAX_LINES): string {
  if (!text) return "";
  const input = String(text);
  const lines = input.split("\n");
  const out: string[] = [];
  let skipped = 0;
  let inCommit = false;
  let subjectSeen = false;
  const pushLine = (l: string) => {
    if (out.length < maxLines) { out.push(l); return true; }
    skipped++;
    return false;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (/^commit [0-9a-f]{7,40}$/i.test(trimmed) || /^[*|/\\ ]+commit [0-9a-f]{7,40}/i.test(trimmed)) {
      inCommit = true;
      subjectSeen = false;
      pushLine(line);
      continue;
    }
    if (inCommit) {
      if (/^[*|/\\ ]*(Author|Date):/i.test(trimmed)) { pushLine(trimmed); continue; }
      if (trimmed === "") continue;
      if (!subjectSeen && /^[*|/\\ ]*    \S/.test(line)) { pushLine("  Subject: " + trimmed); subjectSeen = true; continue; }
      if (/^\d+ file\w* changed/.test(trimmed)) { pushLine("  " + trimmed); continue; }
      if (/^diff --git /.test(trimmed)) { pushLine("  ... diff body omitted"); continue; }
      continue;
    }
    const graphMatch = trimmed.match(/^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)/i);
    if (graphMatch) { pushLine(graphMatch[1]!); continue; }
    if (/^[0-9a-f]{7,40}\s+/.test(trimmed)) { pushLine(trimmed); continue; }
    if (/^[*|/\\ ]+$/.test(trimmed) && /[*|/\\]/.test(trimmed)) continue;
    pushLine(trimmed);
  }
  if (skipped > 0) out.push(`... (${skipped} more lines)`);
  const result = out.join("\n");
  if (!result && input) return input;
  if (result.length > input.length) return input;
  return result;
}

function gitStatus(input: string): string {
  const lines = input.split("\n");
  if (lines.length === 0 || (lines.length === 1 && !lines[0]!.trim())) return "Clean working tree";
  let branch = "";
  const stagedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const longBranch = raw.match(/^On branch (\S+)/);
    if (longBranch) { branch = longBranch[1]!; continue; }
    if (raw.startsWith("##")) { branch = raw.replace(/^##\s*/, ""); continue; }
    if (raw.length >= 3 && /^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const x = raw[0]!;
      const y = raw[1]!;
      const file = raw.slice(3);
      if (raw.slice(0, 2) === "??") { untracked++; untrackedFiles.push(file); continue; }
      if ("MADRC".includes(x)) { staged++; stagedFiles.push(file); } else if (x === "U") conflicts++;
      if (y === "M" || y === "D") { modified++; modifiedFiles.push(file); }
      continue;
    }
    const longMatch = raw.match(/^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/);
    if (longMatch) {
      const kind = longMatch[1]!;
      const path = longMatch[2]!.trim();
      if (kind === "both modified") conflicts++;
      else if (kind === "modified" || kind === "deleted") { modified++; modifiedFiles.push(path); }
      else if (kind === "new file" || kind === "renamed") { staged++; stagedFiles.push(path); }
      continue;
    }
  }
  let out = "";
  if (branch) out += `* ${branch}\n`;
  if (staged > 0) {
    out += `+ Staged: ${staged} files\n`;
    for (const f of stagedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}\n`;
    if (stagedFiles.length > STATUS_MAX_FILES) out += `   ... +${stagedFiles.length - STATUS_MAX_FILES} more\n`;
  }
  if (modified > 0) {
    out += `~ Modified: ${modified} files\n`;
    for (const f of modifiedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}\n`;
    if (modifiedFiles.length > STATUS_MAX_FILES) out += `   ... +${modifiedFiles.length - STATUS_MAX_FILES} more\n`;
  }
  if (untracked > 0) {
    out += `? Untracked: ${untracked} files\n`;
    for (const f of untrackedFiles.slice(0, STATUS_MAX_UNTRACKED)) out += `   ${f}\n`;
    if (untrackedFiles.length > STATUS_MAX_UNTRACKED) out += `   ... +${untrackedFiles.length - STATUS_MAX_UNTRACKED} more\n`;
  }
  if (conflicts > 0) out += `conflicts: ${conflicts} files\n`;
  if (staged === 0 && modified === 0 && untracked === 0 && conflicts === 0) out += "clean — nothing to commit\n";
  return out.replace(/\n+$/, "");
}

function grep(input: string): string {
  const byFile = new Map<string, Array<[string, string]>>();
  let total = 0;
  for (const line of input.split("\n")) {
    const first = line.indexOf(":");
    if (first === -1) continue;
    const second = line.indexOf(":", first + 1);
    if (second === -1) continue;
    const file = line.slice(0, first);
    const lineNumStr = line.slice(first + 1, second);
    const content = line.slice(second + 1);
    if (!/^\d+$/.test(lineNumStr)) continue;
    total++;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push([lineNumStr, content]);
  }
  if (total === 0) return input;
  const files = Array.from(byFile.keys()).sort();
  let out = `${total} matches in ${files.length}F:\n\n`;
  for (const file of files) {
    const matches = byFile.get(file)!;
    out += `[file] ${file} (${matches.length}):\n`;
    for (const [lineNum, content] of matches.slice(0, GREP_PER_FILE_MAX)) out += `  ${lineNum.padStart(4)}: ${content.trim()}\n`;
    if (matches.length > GREP_PER_FILE_MAX) out += `  +${matches.length - GREP_PER_FILE_MAX}\n`;
    out += "\n";
  }
  return out;
}

const LS_DATE_RE = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+/;

function humanSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

function parseLsLine(line: string): { fileType: string; size: number; name: string } | null {
  const m = LS_DATE_RE.exec(line);
  if (!m) return null;
  const name = line.slice(m.index + m[0].length);
  const beforeDate = line.slice(0, m.index);
  const beforeParts = beforeDate.split(/\s+/).filter(Boolean);
  if (beforeParts.length < 4) return null;
  const perms = beforeParts[0]!;
  const fileType = perms.charAt(0);
  let size = 0;
  for (let i = beforeParts.length - 1; i >= 0; i--) {
    const n = Number(beforeParts[i]);
    if (Number.isInteger(n) && String(n) === beforeParts[i]) { size = n; break; }
  }
  return { fileType, size, name };
}

function ls(input: string): string {
  const dirs: string[] = [];
  const files: Array<[string, string]> = [];
  const byExt = new Map<string, number>();
  for (const line of input.split("\n")) {
    if (line.startsWith("total ") || line.length === 0) continue;
    const parsed = parseLsLine(line);
    if (!parsed) continue;
    if (parsed.name === "." || parsed.name === "..") continue;
    if (LS_NOISE_DIRS.includes(parsed.name)) continue;
    if (parsed.fileType === "d") dirs.push(parsed.name);
    else if (parsed.fileType === "-" || parsed.fileType === "l") {
      const dot = parsed.name.lastIndexOf(".");
      const ext = dot > 0 ? parsed.name.slice(dot) : "no ext";
      byExt.set(ext, (byExt.get(ext) || 0) + 1);
      files.push([parsed.name, humanSize(parsed.size)]);
    }
  }
  if (dirs.length === 0 && files.length === 0) return input;
  let out = "";
  for (const d of dirs) out += `${d}/\n`;
  for (const [name, size] of files) out += `${name}  ${size}\n`;
  let summary = `\nSummary: ${files.length} files, ${dirs.length} dirs`;
  if (byExt.size > 0) {
    const ext = Array.from(byExt.entries()).sort((a, b) => b[1] - a[1]);
    const parts = ext.slice(0, LS_EXT_SUMMARY_TOP).map(([e, c]) => `${c} ${e}`);
    summary += ` (${parts.join(", ")}`;
    if (ext.length > LS_EXT_SUMMARY_TOP) summary += `, +${ext.length - LS_EXT_SUMMARY_TOP} more`;
    summary += ")";
  }
  return out + summary;
}

function readNumbered(input: string): string {
  const lines = input.split("\n");
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input;
  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;
  return [...head, `... +${cut} lines truncated (file continues)`, ...tail].join("\n");
}

const READ_NUMBERED_LINE_RE = /^\s*\d+\|/;

function searchList(input: string): string {
  const lines = input.split("\n");
  if (lines.length === 0) return input;
  const header = lines[0] || "";
  const paths: string[] = [];
  for (const raw of lines.slice(1)) {
    const t = raw.trim();
    if (!t.startsWith("- ")) continue;
    paths.push(t.slice(2));
  }
  if (paths.length === 0) return input;
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const dir = slash === -1 ? "." : (p.slice(0, slash) || "/");
    const name = slash === -1 ? p : p.slice(slash + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(name);
  }
  const dirs = Array.from(byDir.keys()).sort();
  let out = `${header}\n${paths.length} files in ${dirs.length} dirs:\n\n`;
  for (const dir of dirs.slice(0, SEARCH_LIST_TOTAL_DIR_MAX)) {
    const names = byDir.get(dir)!;
    out += `${dir}/ (${names.length}):\n`;
    for (const n of names.slice(0, SEARCH_LIST_PER_DIR_MAX)) out += `  ${n}\n`;
    if (names.length > SEARCH_LIST_PER_DIR_MAX) out += `  +${names.length - SEARCH_LIST_PER_DIR_MAX}\n`;
    out += "\n";
  }
  if (dirs.length > SEARCH_LIST_TOTAL_DIR_MAX) out += `+${dirs.length - SEARCH_LIST_TOTAL_DIR_MAX} more dirs\n`;
  return out.replace(/\n+$/, "");
}

const SEARCH_LIST_HEADER_RE = /^Result of search in '[^']*' \(total (\d+) files?\):/;

// ---------------------------------------------------------------------------
// Autodetection (port of auto_detect_filter + JS extras)
// ---------------------------------------------------------------------------

const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_DIFF_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_BUILD_OUTPUT = /^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im;
const RE_TREE_GLYPH = /[├└]──|│  /;
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
const RE_LS_TOTAL = /^total \d+$/m;

function isGrepLine(line: string): boolean {
  const first = line.indexOf(":");
  if (first === -1) return false;
  const second = line.indexOf(":", first + 1);
  if (second === -1) return false;
  return /^\d+$/.test(line.slice(first + 1, second));
}

function isPathLike(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.includes(":")) return false;
  return t.startsWith(".") || t.startsWith("/") || t.includes("/");
}

function isMostlyPorcelain(head: string): boolean {
  const lines = head.split("\n").filter((l) => l.trim());
  if (lines.length < 3) return false;
  const hits = lines.filter((l) => RE_PORCELAIN.test(l)).length;
  return hits / lines.length >= 0.6;
}

function isLineNumbered(lines: string[]): boolean {
  let hits = 0;
  let nonEmpty = 0;
  for (const l of lines.slice(0, 100)) {
    if (l.length === 0) continue;
    nonEmpty++;
    if (READ_NUMBERED_LINE_RE.test(l)) hits++;
  }
  if (nonEmpty < 5) return false;
  return hits / nonEmpty >= READ_NUMBERED_MIN_HIT_RATIO;
}

function countMatches(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return (text.match(g) || []).length;
}

export interface NamedFilter {
  name: string;
  fn: (text: string) => string;
}

/** Detection order mirrors the legacy pipe_cmd port. */
export function autoDetectFilter(text: string): NamedFilter | null {
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;

  if (RE_GIT_LOG.test(head)) return { name: "git-log", fn: gitLog };
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HUNK.test(head)) return { name: "git-diff", fn: gitDiff };
  if (RE_GIT_STATUS.test(head)) return { name: "git-status", fn: gitStatus };
  // Build output BEFORE porcelain check: prevents cargo "Compiling" misdetection.
  if (RE_BUILD_OUTPUT.test(head)) return { name: "build-output", fn: buildOutput };
  if (isMostlyPorcelain(head)) return { name: "git-status", fn: gitStatus };

  const lines = head.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);

  if (nonEmpty.slice(0, 5).some(isGrepLine)) return { name: "grep", fn: grep };
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return { name: "find", fn: find };
  if (RE_TREE_GLYPH.test(head)) return { name: "tree", fn: tree };
  if (RE_LS_TOTAL.test(head) || countMatches(head, RE_LS_ROW) >= 3) return { name: "ls", fn: ls };
  if (SEARCH_LIST_HEADER_RE.test(head)) return { name: "search-list", fn: searchList };
  if (lines.length >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(lines)) {
    return { name: "read-numbered", fn: readNumbered };
  }
  if (nonEmpty.length >= 5) return { name: "dedup-log", fn: dedupLog };
  if (text.split("\n").length >= SMART_TRUNCATE_MIN_LINES) return { name: "smart-truncate", fn: smartTruncate };
  return null;
}

/** Apply one filter fail-open: any failure, empty output, or growth keeps the original. */
export function safeApplyFilter(filter: NamedFilter, text: string): string {
  try {
    const out = filter.fn(text);
    if (typeof out !== "string" || out.length === 0) return text;
    return out.length > text.length ? text : out;
  } catch {
    return text;
  }
}

/** Compress one tool-result text fail-open. Logs only sizes and filter name. */
export function compressToolResult(logger: Logger, text: string): string {
  if (text.length < MIN_COMPRESS_SIZE || text.length > RAW_CAP) return text;
  const filter = autoDetectFilter(text);
  if (!filter) return text;
  const out = safeApplyFilter(filter, text);
  if (out !== text) {
    logger.debug("rtk compressed tool result", {
      filter: filter.name,
      beforeChars: text.length,
      afterChars: out.length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Caveman & Ponytail prompts (legacy wording preserved)
// ---------------------------------------------------------------------------

const SHARED_BOUNDARIES = "Code blocks, file paths, commands, errors, URLs: keep exact. Security warnings, irreversible action confirmations, multi-step ordered sequences: write normal. Resume terse style after.";
const SHARED_EXAMPLES = "Not: \"Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by...\" Yes: \"Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:\"";
const SHARED_AUTO_CLARITY = "Auto-Clarity: drop caveman for security warnings, irreversible actions, multi-step sequences where fragment ambiguity risks misread, or when user repeats a question. Resume after the clear part.";
const SHARED_PERSISTENCE = "ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure.";
const SHARED_NO_INVENTED_ABBREV = "No invented abbreviations. Standard well-known tech acronyms (DB, API, HTTP, URL, JSON, ID, OS, CPU) OK. Names of code symbols, function names, API names, error strings: keep verbatim.";
const SHARED_PRESERVE_LANGUAGE = "Preserve the user's dominant language. User wrote Vietnamese, reply Vietnamese. User wrote English, reply English. Wenyan/classical-Chinese levels override this language-preservation rule. Code identifiers, error strings, file paths, commands: keep in their original form regardless of language.";
const SHARED_NO_SELF_REFERENCE = 'No self-reference. Do not name or announce the style (no "caveman mode", no "me caveman think", no "compressed mode active"). Just respond.';
const SHARED_NO_DECORATION = 'No decorative emoji. No narrating tool calls ("I will now search", "I used X to find Y"). No status phrases ("Sure!", "Of course!", "I\'d be happy to"). No causal arrow shorthand ("A -> B -> fails"). State the thing, the action, the reason. Then next step.';

export const CAVEMAN_PROMPTS: Record<TokenSaverLevel, string> = {
  lite: [
    "Respond tersely. Keep grammar and full sentences but drop filler, hedging and pleasantries (just/really/basically/sure/of course/I'd be happy to).",
    "Pattern: state the thing, the action, the reason. Then next step.",
    SHARED_EXAMPLES,
    SHARED_BOUNDARIES,
    SHARED_AUTO_CLARITY,
    SHARED_PERSISTENCE,
    SHARED_NO_INVENTED_ABBREV,
    SHARED_PRESERVE_LANGUAGE,
    SHARED_NO_SELF_REFERENCE,
    SHARED_NO_DECORATION,
  ].join(" "),
  full: [
    "Respond like terse caveman. All technical substance stay exact, only fluff die.",
    "Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms (big not extensive, fix not implement a solution for).",
    "Pattern: [thing] [action] [reason]. [next step].",
    SHARED_EXAMPLES,
    SHARED_BOUNDARIES,
    SHARED_AUTO_CLARITY,
    SHARED_PERSISTENCE,
    SHARED_NO_INVENTED_ABBREV,
    SHARED_PRESERVE_LANGUAGE,
    SHARED_NO_SELF_REFERENCE,
    SHARED_NO_DECORATION,
  ].join(" "),
  ultra: [
    "Respond ultra-terse. Maximum compression. Telegraphic.",
    "Strip conjunctions. One word when one word enough.",
    "Pattern: [thing] [action] [reason]. [next step].",
    SHARED_EXAMPLES,
    SHARED_BOUNDARIES,
    SHARED_AUTO_CLARITY,
    SHARED_PERSISTENCE,
    SHARED_NO_INVENTED_ABBREV,
    SHARED_PRESERVE_LANGUAGE,
    SHARED_NO_SELF_REFERENCE,
    SHARED_NO_DECORATION,
  ].join(" "),
};

const P_SHARED_PERSONA = "You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.";
const P_SHARED_LADDER = "Before writing code, stop at the first rung that holds: 1) Does this need to exist at all? (YAGNI) 2) Stdlib does it? Use it. 3) Native platform feature covers it? Use it (CSS over JS, DB constraint over app code). 4) Already-installed dependency solves it? Use it; never add a new one for what a few lines can do. 5) Can it be one line? One line. 6) Only then: the minimum code that works.";
const P_SHARED_RULES = "No unrequested abstractions (no interface with one implementation, no factory for one product, no config for a value that never changes). No boilerplate or scaffolding \"for later\". Deletion over addition. Boring over clever. Fewest files possible; shortest working diff wins. Two stdlib options the same size: take the edge-case-correct one. Mark deliberate simplifications with a `ponytail:` comment naming the ceiling and upgrade path.";
const P_SHARED_OUTPUT = "Code first. Then at most three short lines: what was skipped, when to add it. No essays or design notes. Pattern: `[code] → skipped: [X], add when [Y].`";
const P_SHARED_NOT_LAZY = "Never simplify away: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything explicitly requested. Non-trivial logic leaves ONE runnable check behind (an assert-based self-check or one small test file; no frameworks). Trivial one-liners need no test.";
const P_SHARED_PERSISTENCE = "ACTIVE EVERY RESPONSE. No drift back to over-building. Still active if unsure.";

export const PONYTAIL_PROMPTS: Record<TokenSaverLevel, string> = {
  lite: [
    P_SHARED_PERSONA,
    "Lite: build what's asked, but name the lazier alternative in one line. User picks.",
    P_SHARED_LADDER,
    P_SHARED_RULES,
    P_SHARED_OUTPUT,
    P_SHARED_NOT_LAZY,
    P_SHARED_PERSISTENCE,
  ].join(" "),
  full: [
    P_SHARED_PERSONA,
    "Full: the ladder enforced. Stdlib and native first. Shortest diff, shortest explanation.",
    P_SHARED_LADDER,
    P_SHARED_RULES,
    P_SHARED_OUTPUT,
    P_SHARED_NOT_LAZY,
    P_SHARED_PERSISTENCE,
  ].join(" "),
  ultra: [
    P_SHARED_PERSONA,
    "Ultra: YAGNI extremist. Deletion before addition. Ship the one-liner and challenge the rest of the requirement in the same response.",
    P_SHARED_LADDER,
    P_SHARED_RULES,
    P_SHARED_OUTPUT,
    P_SHARED_NOT_LAZY,
    P_SHARED_PERSISTENCE,
  ].join(" "),
};

/**
 * Append one fixed system-prompt segment. Idempotent: an existing exact
 * segment is detected and not duplicated. Fails open on any error.
 */
export function appendSystemPrompt(req: NormalizedRequest, prompt: string): void {
  try {
    const segment = `\n\n${prompt}`;
    if (req.system === undefined || req.system === "") {
      req.system = prompt;
      return;
    }
    if (req.system.includes(segment) || req.system === prompt) return;
    req.system += segment;
  } catch {
    // fail open: leave the request untouched
  }
}

/**
 * Apply the enabled Token Saver transforms to a normalized request, exactly
 * once, in order: RTK, Caveman, Ponytail. Every step fails open.
 */
export function applyTokenSaverTransforms(db: Database, logger: Logger, req: NormalizedRequest): void {
  try {
    const settings = getSettings(db);
    if (settings.rtkEnabled) {
      for (const message of req.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
          if (part.type !== "tool_result" || part.is_error) continue;
          part.content = compressToolResult(logger, part.content);
        }
      }
    }
    if (settings.cavemanEnabled) {
      appendSystemPrompt(req, CAVEMAN_PROMPTS[settings.cavemanLevel]);
    }
    if (settings.ponytailEnabled) {
      appendSystemPrompt(req, PONYTAIL_PROMPTS[settings.ponytailLevel]);
    }
  } catch (error) {
    logger.warn("token saver transform failed; passing request through", { error: (error as Error).message });
  }
}
