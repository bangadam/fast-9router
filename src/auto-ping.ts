import type { Database } from "bun:sqlite";
import { CATALOGS } from "./catalog.ts";
import { listConnections, updateConnection, type ProviderConnectionWithCooldown } from "./db.ts";
import { Logger } from "./log.ts";
import { routeGenerationRequest } from "./router/pipeline.ts";

type Route = typeof routeGenerationRequest;

function pingModel(connection: ProviderConnectionWithCooldown): string | null {
  const configured = connection.data.models?.[0];
  if (connection.provider === "openai") {
    return configured && connection.data.prefix ? `${connection.data.prefix}/${configured}` : null;
  }
  const catalog = CATALOGS.find((entry) => entry.provider === connection.provider);
  const model = configured ?? catalog?.models.find((entry) => !entry.id.endsWith("-review"))?.id;
  return model ? `${catalog?.prefix}/${model}` : null;
}

export async function runAutoPingTick(
  db: Database,
  logger: Logger,
  armedAfter: number,
  now = Date.now(),
  route: Route = routeGenerationRequest,
): Promise<void> {
  const due = listConnections(db).filter((connection) =>
    connection.isActive === 1
    && connection.data.autoPing === true
    && connection.unavailableUntil !== null
    && connection.unavailableUntil >= armedAfter
    && connection.unavailableUntil <= now);
  for (const connection of due) {
    const claimed = db.query("UPDATE providerConnections SET unavailableUntil = NULL WHERE id = ? AND unavailableUntil = ?")
      .run(connection.id, connection.unavailableUntil) as { changes: number };
    if (claimed.changes === 0) continue;
    const model = pingModel(connection);
    let response: Response;
    if (model) {
      response = await route(db, logger, "/v1/chat/completions", {
        model,
        stream: false,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }, undefined, 15_000, [connection.id], "Internal Auto-ping");
    } else {
      response = Response.json({ error: { message: "no configured model", type: "invalid_request_error" } }, { status: 400 });
    }
    if (response.ok) {
      logger.info("connection auto-ping completed", { provider: connection.provider, connectionId: connection.id, model });
      continue;
    }
    const current = listConnections(db).find((entry) => entry.id === connection.id);
    if (current) updateConnection(db, current.id, { data: { ...current.data, autoPing: false } });
    logger.warn("connection auto-ping disabled after failure", { provider: connection.provider, connectionId: connection.id, model, status: response.status });
  }
}

export function startAutoPingScheduler(db: Database, logger: Logger, intervalMs = 30_000): () => void {
  const armedAfter = Date.now();
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runAutoPingTick(db, logger, armedAfter).catch((error) => {
      logger.error("auto-ping scheduler failed", { error: (error as Error).message });
    }).finally(() => { running = false; });
  }, intervalMs);
  return () => clearInterval(timer);
}
