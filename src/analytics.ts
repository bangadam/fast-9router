import type { Database } from "bun:sqlite";
import { apiKeyUsageSince, endpointUsageSince, hourlyUsageSince, listConnections, recentUsageSince } from "./db.ts";
import { estimateCost } from "./pricing.ts";

export type UsagePeriod = "today" | "24h" | "7d" | "30d" | "60d";
export interface CostBreakdown { input: number; cached: number; output: number; total: number }

type ProviderTotals = {
  provider: string; connectionId: number; connectionName: string; requests: number; failures: number;
  promptTokens: number | null; cachedTokens: number | null; completionTokens: number | null; cost: CostBreakdown; lastUsed: number | null;
};
type ModelTotals = {
  model: string; requests: number; failures: number; promptTokens: number | null; cachedTokens: number | null;
  completionTokens: number | null; lastUsed: number | null; providers: Map<string, ProviderTotals>;
};
type TimelinePoint = {
  hour: string; requests: number; failures: number; promptTokens: number; cachedTokens: number;
  completionTokens: number; cost: number;
};

export function periodStart(period: UsagePeriod, now = Date.now()): number {
  const date = new Date(now);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (period === "today") return today;
  if (period === "24h") return Math.floor(now / 3_600_000) * 3_600_000 - 23 * 3_600_000;
  const days = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  return today - (days - 1) * 86_400_000;
}

function costFor(model: string, prompt: number | null, cached: number | null, output: number | null): CostBreakdown {
  const cost = estimateCost(model, prompt, cached, output);
  return { input: cost.inputCost, cached: cost.cachedCost, output: cost.outputCost, total: cost.cost };
}

export function buildUsageAnalytics(db: Database, period: UsagePeriod, now = Date.now()) {
  const since = periodStart(period, now);
  const hourly = hourlyUsageSince(db, new Date(since).toISOString().slice(0, 13));
  const endpointRows = endpointUsageSince(db, new Date(since).toISOString().slice(0, 13));
  const apiKeyRows = apiKeyUsageSince(db, new Date(since).toISOString().slice(0, 13));
  const recent = recentUsageSince(db, since, 500);
  const connections = listConnections(db);
  const models = new Map<string, ModelTotals>();
  const timeline = new Map<string, TimelinePoint>();
  let requests = 0;
  let failures = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let completionTokens = 0;
  let totalCost = 0;

  for (const row of hourly) {
    requests += row.requests;
    failures += row.failedRequests;
    promptTokens += row.promptTokens ?? 0;
    cachedTokens += row.cachedTokens ?? 0;
    completionTokens += row.completionTokens ?? 0;
    const cost = costFor(row.model, row.promptTokens, row.cachedTokens, row.completionTokens);
    totalCost += cost.total;

    const point = timeline.get(row.hourKey) ?? { hour: row.hourKey, requests: 0, failures: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 };
    point.requests += row.requests;
    point.failures += row.failedRequests;
    point.promptTokens += row.promptTokens ?? 0;
    point.cachedTokens += row.cachedTokens ?? 0;
    point.completionTokens += row.completionTokens ?? 0;
    point.cost += cost.total;
    timeline.set(row.hourKey, point);

    const connection = connections.find((entry) => entry.id === row.connectionId);
    const group = models.get(row.model) ?? { model: row.model, requests: 0, failures: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, lastUsed: null, providers: new Map() };
    group.requests += row.requests;
    group.failures += row.failedRequests;
    group.promptTokens = (group.promptTokens ?? 0) + (row.promptTokens ?? 0);
    group.cachedTokens = (group.cachedTokens ?? 0) + (row.cachedTokens ?? 0);
    group.completionTokens = (group.completionTokens ?? 0) + (row.completionTokens ?? 0);
    const childKey = `${row.provider}:${row.connectionId}`;
    const approximateLastUsed = Date.parse(`${row.hourKey}:59:59.999Z`);
    group.lastUsed = Math.min(now, Math.max(group.lastUsed ?? 0, approximateLastUsed));
    const child = group.providers.get(childKey) ?? { provider: row.provider, connectionId: row.connectionId, connectionName: connection?.name ?? `Connection ${row.connectionId}`, requests: 0, failures: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: { input: 0, cached: 0, output: 0, total: 0 }, lastUsed: null };
    child.requests += row.requests;
    child.failures += row.failedRequests;
    child.promptTokens = (child.promptTokens ?? 0) + (row.promptTokens ?? 0);
    child.cachedTokens = (child.cachedTokens ?? 0) + (row.cachedTokens ?? 0);
    child.completionTokens = (child.completionTokens ?? 0) + (row.completionTokens ?? 0);
    child.lastUsed = Math.min(now, Math.max(child.lastUsed ?? 0, approximateLastUsed));
    child.cost = costFor(row.model, child.promptTokens, child.cachedTokens, child.completionTokens);
    group.providers.set(childKey, child);
    models.set(row.model, group);
  }

  for (const record of recent) {
    const group = models.get(record.model);
    if (group && (group.lastUsed === null || record.createdAt > group.lastUsed)) group.lastUsed = record.createdAt;
    const child = group?.providers.get(`${record.provider}:${record.connectionId}`);
    if (child && (child.lastUsed === null || record.createdAt > child.lastUsed)) child.lastUsed = record.createdAt;
  }

  const modelRows = [...models.values()].map((group) => ({
    ...group,
    providers: [...group.providers.values()].sort((a, b) => b.requests - a.requests || a.connectionId - b.connectionId),
    cost: costFor(group.model, group.promptTokens, group.cachedTokens, group.completionTokens),
  })).sort((a, b) => a.model.localeCompare(b.model));
  const accounts = modelRows.flatMap((model) => model.providers.map((provider) => ({ ...provider, model: model.model })));
  const endpointGroups = new Map<string, { endpoint: string; model: string; provider: string; connectionId: number; connectionName: string; requests: number; failures: number; promptTokens: number; cachedTokens: number; completionTokens: number; lastUsed: number | null; cost: CostBreakdown }>();
  for (const row of endpointRows) {
    const key = `${row.endpoint}\u0000${row.model}\u0000${row.provider}\u0000${row.connectionId}`;
    const current = endpointGroups.get(key) ?? { endpoint: row.endpoint, model: row.model, provider: row.provider, connectionId: row.connectionId, connectionName: connections.find((connection) => connection.id === row.connectionId)?.name ?? `Connection ${row.connectionId}`, requests: 0, failures: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, lastUsed: null, cost: { input: 0, cached: 0, output: 0, total: 0 } };
    current.lastUsed = Math.min(now, Math.max(current.lastUsed ?? 0, Date.parse(`${row.hourKey}:59:59.999Z`)));
    current.requests += row.requests; current.failures += row.failedRequests; current.promptTokens += row.promptTokens ?? 0; current.cachedTokens += row.cachedTokens ?? 0; current.completionTokens += row.completionTokens ?? 0;
    current.cost = costFor(row.model, current.promptTokens, current.cachedTokens, current.completionTokens);
    endpointGroups.set(key, current);
  }
  for (const record of recent) {
    if (!record.endpoint) continue;
    const item = endpointGroups.get(`${record.endpoint}\u0000${record.model}\u0000${record.provider}\u0000${record.connectionId}`);
    if (item && (item.lastUsed === null || record.createdAt > item.lastUsed)) item.lastUsed = record.createdAt;
  }
  const endpoints = [...endpointGroups.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint) || a.model.localeCompare(b.model));
  const apiKeyGroups = new Map<string, { keyName: string; model: string; provider: string; connectionId: number; connectionName: string; requests: number; failures: number; promptTokens: number; cachedTokens: number; completionTokens: number; lastUsed: number | null; cost: CostBreakdown }>();
  for (const row of apiKeyRows) {
    const key = `${row.keyName}\u0000${row.model}\u0000${row.provider}\u0000${row.connectionId}`;
    const current = apiKeyGroups.get(key) ?? { keyName: row.keyName, model: row.model, provider: row.provider, connectionId: row.connectionId, connectionName: connections.find((connection) => connection.id === row.connectionId)?.name ?? `Connection ${row.connectionId}`, requests: 0, failures: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, lastUsed: null, cost: { input: 0, cached: 0, output: 0, total: 0 } };
    current.requests += row.requests; current.failures += row.failedRequests; current.promptTokens += row.promptTokens ?? 0; current.cachedTokens += row.cachedTokens ?? 0; current.completionTokens += row.completionTokens ?? 0;
    current.cost = costFor(row.model, current.promptTokens, current.cachedTokens, current.completionTokens);
    current.lastUsed = Math.min(now, Math.max(current.lastUsed ?? 0, Date.parse(`${row.hourKey}:59:59.999Z`)));
    apiKeyGroups.set(key, current);
  }
  for (const record of recent) {
    const item = apiKeyGroups.get(`${record.keyName}\u0000${record.model}\u0000${record.provider}\u0000${record.connectionId}`);
    if (item && (item.lastUsed === null || record.createdAt > item.lastUsed)) item.lastUsed = record.createdAt;
  }
  const apiKeys = [...apiKeyGroups.values()].sort((a, b) => a.keyName.localeCompare(b.keyName) || a.model.localeCompare(b.model));
  const requestsByConnection = new Map<number, number>();
  for (const row of hourly) requestsByConnection.set(row.connectionId, (requestsByConnection.get(row.connectionId) ?? 0) + row.requests);

  const daily = period === "7d" || period === "30d" || period === "60d";
  const step = daily ? 86_400_000 : 3_600_000;
  const groupedTimeline = new Map<string, TimelinePoint>();
  for (const point of timeline.values()) {
    const key = point.hour.slice(0, daily ? 10 : 13);
    const sum = groupedTimeline.get(key) ?? { hour: daily ? `${key}T00` : key, requests: 0, failures: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 };
    sum.requests += point.requests; sum.failures += point.failures; sum.promptTokens += point.promptTokens;
    sum.cachedTokens += point.cachedTokens; sum.completionTokens += point.completionTokens; sum.cost += point.cost;
    groupedTimeline.set(key, sum);
  }
  const timelineEnd = period === "today" ? since + 23 * 3_600_000 : now;
  const filledTimeline: TimelinePoint[] = [];
  for (let at = since; at <= timelineEnd; at += step) {
    const key = new Date(at).toISOString().slice(0, daily ? 10 : 13);
    filledTimeline.push(groupedTimeline.get(key) ?? { hour: daily ? `${key}T00` : key, requests: 0, failures: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 });
  }

  const graphNodes = new Map<string, { id: string; name: string; provider: "codex" | "anthropic" | "openai"; active: boolean; requests: number }>();
  for (const connection of connections) {
    const provider = connection.provider as "codex" | "anthropic" | "openai";
    const id = provider === "openai" ? connection.data.prefix ?? connection.name : provider;
    const name = provider === "codex" ? "OpenAI Codex" : provider === "anthropic" ? "Anthropic" : connection.data.prefix ?? connection.name;
    const node = graphNodes.get(id) ?? { id, name, provider, active: false, requests: 0 };
    node.active ||= connection.isActive === 1;
    node.requests += requestsByConnection.get(connection.id) ?? 0;
    graphNodes.set(id, node);
  }

  return {
    period,
    since,
    generatedAt: now,
    summary: { requests, failures, promptTokens, cachedTokens, completionTokens, estimatedCost: totalCost },
    timeline: filledTimeline,
    models: modelRows,
    accounts,
    endpoints,
    recent: recent.map((record) => ({ ...record, connectionName: connections.find((entry) => entry.id === record.connectionId)?.name ?? `Connection ${record.connectionId}` })),
    apiKeys,
    graph: { router: "Fast 9Router", nodes: [...graphNodes.values()].sort((a, b) => a.name.localeCompare(b.name)) },
  };
}
