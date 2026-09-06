// Devin CLI detection: install probe + version. No config to write.
// Ported from 9router devin-settings route.

import { join } from "node:path";
import { homedir, platform } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { fileExists, type ToolDeps } from "./core.ts";

const execAsync = promisify(exec);

function candidateDevinPaths(): string[] {
  const home = homedir();
  if (platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(localAppData, "devin", "cli", "bin", "devin.exe"),
      join(home, ".local", "bin", "devin.exe"),
      join(home, "scoop", "shims", "devin.exe"),
      join(localAppData, "Programs", "devin", "devin.exe"),
    ];
  }
  return [
    join(home, ".local", "share", "devin", "bin", "devin"),
    join(home, ".devin", "bin", "devin"),
    join(home, ".local", "bin", "devin"),
    "/opt/homebrew/bin/devin",
    "/usr/local/bin/devin",
    "/usr/bin/devin",
  ];
}

async function checkDevinInstalled(): Promise<{ installed: boolean; source: string | null }> {
  for (const candidate of candidateDevinPaths()) {
    if (await fileExists(candidate)) return { installed: true, source: candidate };
  }
  return { installed: false, source: null };
}

export async function devinGet(): Promise<unknown> {
  const { installed, source } = await checkDevinInstalled();
  if (!installed) {
    return {
      installed: false,
      message: "Devin CLI is not installed. Install it from https://cli.devin.ai and run `devin auth login`.",
      installUrl: "https://cli.devin.ai",
    };
  }
  let version: string | null = null;
  try {
    const { stdout } = await execAsync("devin --version", { windowsHide: true });
    version = stdout.trim().split("\n")[0] || null;
  } catch { version = null; }
  return {
    installed: true,
    source,
    version,
    message: "Devin CLI detected. Make sure `devin auth login` has been run.",
  };
}
