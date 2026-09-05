// Configuration: environment variables and simple CLI arguments.
// No configuration framework, no plugin system.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  logLevel: LogLevel;
}

const DEFAULTS: Config = {
  host: "127.0.0.1",
  port: 20129,
  dataDir: "~/.fast-9router",
  logLevel: "info",
};

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function isLogLevel(v: string): v is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(v);
}

/**
 * Parse configuration from argv and env. argv items use `--key value` or
 * `--key=value` form with keys host, port, data-dir, log-level. Environment
 * variables: FAST9R_HOST, FAST9R_PORT, FAST9R_DATA_DIR, FAST9R_LOG_LEVEL.
 * CLI arguments take precedence over environment, environment over defaults.
 */
export function loadConfig(argv: readonly string[] = [], env = process.env): Config {
  const config: Config = { ...DEFAULTS };

  const envMap: Array<[string, (v: string) => void]> = [
    ["FAST9R_HOST", (v) => (config.host = v)],
    ["FAST9R_PORT", (v) => (config.port = Number(v))],
    ["FAST9R_DATA_DIR", (v) => (config.dataDir = v)],
    ["FAST9R_LOG_LEVEL", (v) => {
      if (isLogLevel(v)) config.logLevel = v;
    }],
  ];
  for (const [key, apply] of envMap) {
    const v = env[key];
    if (v !== undefined && v !== "") apply(v);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase();
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = inlineValue ?? argv[i + 1];
    if (next === undefined) continue;
    let matched = true;
    switch (key) {
      case "host":
        config.host = next;
        break;
      case "port":
        config.port = Number(next);
        break;
      case "data-dir":
      case "datadir":
        config.dataDir = next;
        break;
      case "log-level":
        if (isLogLevel(next)) config.logLevel = next;
        break;
      default:
        matched = false;
    }
    if (matched && inlineValue === undefined) i++;
  }

  return config;
}

/** Expand a leading `~` to the home directory; other paths pass through. */
export function expandHome(path: string, home = process.env.HOME ?? ""): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  return path;
}
