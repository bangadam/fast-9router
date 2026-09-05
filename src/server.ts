// Server bootstrap: startup validation, listener, clean shutdown.

import { statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, expandHome, type Config } from "./config.ts";
import { openDatabase, migrate, getSettings } from "./db.ts";
import { createApp } from "./app.ts";
import { getConnInfo } from "hono/bun";
import { Logger } from "./log.ts";
import { isLoopbackHostname, isValidGatewayKey } from "./network.ts";
import { startAutoPingScheduler } from "./auto-ping.ts";

export interface StartupError {
  message: string;
}

/**
 * Validate startup configuration before binding. A non-loopback listener must
 * have both a gateway key and active enforcement; otherwise provider
 * credentials would be reachable without authentication.
 */
export function validateStartupConfig(
  config: Config,
  gatewayKey: string,
  gatewayEnforce = false,
): StartupError | null {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    return { message: `invalid port: ${config.port}` };
  }
  if (!isLoopbackHostname(config.host) && !isValidGatewayKey(gatewayKey)) {
    return {
      message:
        `refusing to bind non-loopback address ${config.host}: ` +
        "set a valid gateway API key of at least 8 characters before exposing the server",
    };
  }
  if (!isLoopbackHostname(config.host) && !gatewayEnforce) {
    return {
      message:
        `refusing to bind non-loopback address ${config.host}: ` +
        "enable gateway key enforcement before exposing the server",
    };
  }
  return null;
}

export function resolveOAuthAppOrigin(config: Config): string {
  const host = config.host.trim().toLowerCase();
  if (host === "" || host === "0.0.0.0") return `http://127.0.0.1:${config.port}`;
  if (host === "::") return `http://[::1]:${config.port}`;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${config.port}`;
}


export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const config = loadConfig(argv);
  const dataDir = expandHome(config.dataDir);
  const logger = new Logger(config.logLevel);

  const db = openDatabase(join(dataDir, "fast-9router.db"));
  migrate(db);
  const settings = getSettings(db);

  const startupError = validateStartupConfig(config, settings.gatewayKey, settings.gatewayEnforce);
  if (startupError) {
    logger.error("startup rejected", { reason: startupError.message });
    db.close();
    return 1;
  }

  const app = createApp(
    db,
    logger,
    (context) => getConnInfo(context).remote.address,
    resolveOAuthAppOrigin(config),
    { gatewayEnforcementRequired: !isLoopbackHostname(config.host) },
  );
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: app.fetch,
  });
  logger.info("listening", { host: server.hostname, port: server.port });
  const stopAutoPing = startAutoPingScheduler(db, logger);

  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    logger.info("shutting down");
    stopAutoPing();
    server.stop(true);
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
