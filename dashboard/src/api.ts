// Typed fetch helpers against the admin API. All errors surface as
// `ApiError` with the server's message.

export class ApiError extends Error {
  constructor(message: string, public status: number, public retryAfter?: number) {
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
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfter = retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
    if (res.status === 401 && path.startsWith("/api/admin/")
      && !path.startsWith("/api/admin/profile/password")
      && !path.startsWith("/api/admin/backup/")) {
      dispatchEvent(new CustomEvent("fast9r:unauthorized"));
    }
    throw new ApiError(message, res.status, retryAfter);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Raw fetch for non-JSON responses (backup download). Errors still normalize to ApiError. */
export async function requestRaw(path: string, method: string, body?: unknown): Promise<Response> {
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
  return res;
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

export interface AuthStatus {
  authenticated: boolean;
  hasPassword: boolean;
  usesDefaultPassword: boolean;
  expiresAt: number | null;
}

export interface AuthSuccess {
  authenticated: boolean;
  expiresAt: number;
}

export interface GatewayKeyDto {
  id: string;
  name: string;
  keyMasked: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GatewaySettings {
  enforce: boolean;
  enforceRequired: boolean;
  keys: GatewayKeyDto[];
}

export interface CreatedGatewayKey {
  key: GatewayKeyDto;
  secret: string;
}

export type TokenSaverLevel = "lite" | "full" | "ultra";

export interface TokenSaverSettings {
  rtkEnabled: boolean;
  cavemanEnabled: boolean;
  cavemanLevel: TokenSaverLevel;
  ponytailEnabled: boolean;
  ponytailLevel: TokenSaverLevel;
}

export interface QuotaRow {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: string | null;
}

export interface CodexQuotaSnapshot {
  connectionId: number;
  connectionName: string;
  active: boolean;
  plan: string | null;
  quotas: QuotaRow[];
  message: string | null;
  error: string | null;
  fetchedAt: number;
  stale: boolean;
  unavailableUntil: number | null;
}

export interface QuotaOverview {
  accounts: CodexQuotaSnapshot[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  generatedAt: number;
}

export interface BackupV1 {
  format: "fast-9router-backup";
  version: 1;
  createdAt: string;
  data: {
    settings: {
      gatewayEnforce: boolean;
      disabledModels: string[];
      rtkEnabled: boolean;
      cavemanEnabled: boolean;
      cavemanLevel: string;
      ponytailEnabled: boolean;
      ponytailLevel: string;
    };
    providerConnections: Array<{
      id: number;
      provider: string;
      name: string;
      isActive: boolean;
      priority: number;
      data: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }>;
    modelAliases: Array<{ id: number; name: string; target: string; createdAt: string }>;
    gatewayApiKeys: Array<{
      id: string;
      name: string;
      secretHash: string;
      secretPrefix: string;
      secretSuffix: string;
      isActive: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
  };
}

export interface BackupImportResult {
  success: boolean;
  counts: { connections: number; aliases: number; gatewayKeys: number };
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
