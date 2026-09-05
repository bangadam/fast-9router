import { EventEmitter } from "node:events";
import type { Database } from "bun:sqlite";
import { listConnections, recentUsageSince } from "./db.ts";

interface ActiveRequest {
  id: number;
  provider: string;
  model: string;
  connectionId: number;
  startedAt: number;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(50);
const active = new Map<number, ActiveRequest>();
let nextId = 1;
let lastError = { provider: "", at: 0 };

function changed(): void {
  emitter.emit("change");
}

export function beginActiveRequest(provider: string, model: string, connectionId: number): number {
  const id = nextId++;
  active.set(id, { id, provider, model, connectionId, startedAt: Date.now() });
  changed();
  return id;
}

export function setActiveRequestConnection(id: number, connectionId: number): void {
  const request = active.get(id);
  if (!request || request.connectionId === connectionId) return;
  request.connectionId = connectionId;
  changed();
}

export function endActiveRequest(id: number, failed = false): void {
  const request = active.get(id);
  if (!request) return;
  active.delete(id);
  if (failed) lastError = { provider: request.provider, at: Date.now() };
  changed();
}

export function subscribeUsageChanges(listener: () => void): () => void {
  emitter.on("change", listener);
  return () => emitter.off("change", listener);
}

export function liveUsageSnapshot(db: Database) {
  const connections = listConnections(db);
  const names = new Map(connections.map((connection) => [connection.id, connection.name]));
  return {
    activeRequests: [...active.values()].map((request) => ({
      provider: request.provider,
      model: request.model,
      account: names.get(request.connectionId) ?? `Connection ${request.connectionId}`,
      connectionId: request.connectionId,
      startedAt: request.startedAt,
    })),
    recentRequests: recentUsageSince(db, 0, 20).map((request) => ({
      timestamp: request.createdAt,
      provider: request.provider === "openai" ? request.model.split("/", 1)[0]! : request.provider,
      model: request.model,
      promptTokens: request.promptTokens,
      cachedTokens: request.cachedTokens,
      completionTokens: request.completionTokens,
      status: request.status < 400 ? "success" : "error",
    })),
    errorProvider: Date.now() - lastError.at < 10_000 ? lastError.provider : "",
  };
}

export function resetLiveUsageState(): void {
  active.clear();
  lastError = { provider: "", at: 0 };
  emitter.removeAllListeners();
  nextId = 1;
}
