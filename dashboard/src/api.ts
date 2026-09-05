// Typed fetch helpers against the admin API. All errors surface as
// `ApiError` with the server's message.

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, method?: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(`network error: ${(e as Error).message}`, 0);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { error?: { message?: string } };
      if (json.error?.message) message = json.error.message;
    } catch { /* non-JSON error body */ }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const get = <T>(path: string) => request<T>(path);
export const send = <T>(path: string, method: string, body?: unknown) => request<T>(path, method, body);

// --- Payload types (mirror src/app.ts responses) ---

export type Provider = "codex" | "anthropic" | "openai";

export interface MaskedConnection {
  id: number;
  provider: Provider;
  name: string;
  isActive: boolean;
  routable: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  data: {
    baseUrl?: string;
    prefix?: string;
    models?: string[];
    apiKey?: string; // "********" when set, undefined when unset
    email?: string;
    planType?: string;
    autoPing?: boolean;
  };
}

export interface Alias {
  id: number;
  name: string;
  target: string;
  createdAt: string;
}

export interface GatewaySettings {
  enforce: boolean;
  keyConfigured: boolean;
  keyMasked: string | null;
  enforceRequired: boolean;
}

export interface StatusInfo {
  version: string;
  uptimeSeconds: number;
  connections: { total: number; active: number };
  models: number;
}

export interface UsageRow {
  dateKey: string;
  provider: string;
  model: string;
  connectionId: number;
  requests: number;
  promptTokens: number | null;
  completionTokens: number | null;
  failedRequests: number;
}

export type UsagePeriod = "today" | "24h" | "7d" | "30d" | "60d";
export interface CostBreakdown { input: number; cached: number; output: number; total: number }
export interface AnalyticsModelProvider {
  provider: string; connectionId: number; connectionName: string; requests: number; failures: number;
  promptTokens: number | null; cachedTokens: number | null; completionTokens: number | null; cost: CostBreakdown; lastUsed: number | null;
}
export interface AnalyticsModel {
  model: string; requests: number; failures: number; promptTokens: number | null; cachedTokens: number | null;
  completionTokens: number | null; lastUsed: number | null; cost: CostBreakdown; providers: AnalyticsModelProvider[];
}
export interface AnalyticsAccount extends AnalyticsModelProvider { model: string }
export interface AnalyticsEndpoint extends AnalyticsAccount { endpoint: string }
export interface AnalyticsApiKey extends AnalyticsAccount { keyName: string }
export interface LiveUsage {
  activeRequests: Array<{ provider: string; model: string; account: string; connectionId: number; startedAt: number }>;
  recentRequests: Array<{ timestamp: number; provider: string; model: string; promptTokens: number | null; cachedTokens: number | null; completionTokens: number | null; status: "success" | "error" }>;
  errorProvider: string;
}
export interface UsageStats extends LiveUsage {
  period: UsagePeriod; since: number; generatedAt: number;
  summary: { requests: number; failures: number; promptTokens: number; cachedTokens: number; completionTokens: number; estimatedCost: number };
  models: AnalyticsModel[];
  accounts: AnalyticsAccount[];
  endpoints: AnalyticsEndpoint[];
  apiKeys: AnalyticsApiKey[];
  graph: { router: string; nodes: Array<{ id: string; name: string; provider: Provider; active: boolean; requests: number }> };
}
export interface UsageChartPoint { hour: string; label: string; requests: number; failures: number; promptTokens: number; cachedTokens: number; completionTokens: number; tokens: number; cost: number }
export interface RequestUsageDetail { id: number; createdAt: number; endpoint: string | null; provider: string; model: string; connectionId: number; connectionName: string; status: number; latencyMs: number | null; ttftMs: number | null; promptTokens: number | null; cachedTokens: number | null; completionTokens: number | null; keyName: string }
export interface RequestDetailsResponse { details: RequestUsageDetail[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number } }

export interface ModelsList {
  object: "list";
  data: { id: string; object: "model"; owned_by: string }[];
}
