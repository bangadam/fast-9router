// Quota screen: Codex connection quota with all/active/inactive filter,
// 60-second auto-refresh countdown, per-account refresh, and pagination.

import { useCallback, useEffect, useRef, useState } from "react";
import { get, send, ApiError, type CodexQuotaSnapshot, type QuotaOverview } from "./api.ts";
import { Notice, useToast } from "./app.tsx";
import { Badge, Button, Card, Icon, SectionHeader, Skeleton, Toggle } from "./primitives.tsx";

type AccountStatus = "all" | "active" | "inactive";
const STORAGE_KEY = "fast9r-quota-auto-refresh";
const TTL_MS = 60_000;

export function QuotaScreen() {
  const notify = useToast();
  const [accounts, setAccounts] = useState<CodexQuotaSnapshot[] | null>(null);
  const [pagination, setPagination] = useState<{ page: number; pageSize: number; total: number; totalPages: number } | null>(null);
  const [accountStatus, setAccountStatus] = useState<AccountStatus>("all");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(localStorage.getItem(STORAGE_KEY) === "1");
  const [countdown, setCountdown] = useState(TTL_MS / 1000);
  const [lastFetch, setLastFetch] = useState(0);
  const reqIdRef = useRef(0);

  const fetchPage = useCallback(async (force: boolean) => {
    const id = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const overview = await get<QuotaOverview>(`/api/admin/quota?page=${page}&pageSize=20&accountStatus=${accountStatus}&force=${force ? "1" : "0"}`);
      if (id !== reqIdRef.current) return;
      setAccounts(overview.accounts);
      setPagination(overview.pagination);
      setLastFetch(Date.now());
      setCountdown(TTL_MS / 1000);
    } catch (reason) {
      if (id !== reqIdRef.current) return;
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      if (id === reqIdRef.current) setLoading(false);
    }
  }, [page, accountStatus]);

  useEffect(() => { void fetchPage(false); }, [fetchPage]);

  useEffect(() => {
    setCountdown(TTL_MS / 1000);
    const timer = window.setInterval(() => {
      setCountdown((remaining) => {
        const next = remaining - 1;
        if (next <= 0 && autoRefresh && !document.hidden && Date.now() - lastFetch >= TTL_MS) {
          void fetchPage(true);
          return TTL_MS / 1000;
        }
        return Math.max(0, next);
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, fetchPage, lastFetch]);

  useEffect(() => {
    if (document.hidden) return;
    const onVisible = () => {
      if (document.hidden) return;
      if (Date.now() - lastFetch >= TTL_MS) void fetchPage(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchPage, lastFetch]);

  const refreshOne = async (connectionId: number) => {
    setRefreshing(true);
    try {
      const snapshot = await get<CodexQuotaSnapshot>(`/api/admin/quota/${connectionId}?force=1`);
      setAccounts((current) => current?.map((account) => account.connectionId === connectionId ? snapshot : account) ?? null);
    } catch (reason) {
      notify(reason instanceof ApiError ? reason.message : String(reason), "error");
    } finally {
      setRefreshing(false);
    }
  };

  const toggleAutoRefresh = (enabled: boolean) => {
    setAutoRefresh(enabled);
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
    setCountdown(TTL_MS / 1000);
  };

  return (
    <section>
      <SectionHeader
        title="Quota Tracker"
        description="Live Codex usage windows for active sessions and weekly limits."
        action={
          <div className="quota-toolbar">
            <Button variant="ghost" size="sm" icon="sync" onClick={() => void fetchPage(true)} disabled={loading}>Refresh All</Button>
            <Toggle checked={autoRefresh} label="Auto-refresh" onChange={toggleAutoRefresh} />
            <small className="quota-countdown" aria-hidden="true">{countdown}s</small>
          </div>
        }
      />
      <div className="quota-filter">
        {(["all", "active", "inactive"] as AccountStatus[]).map((status) => (
          <button key={status} type="button" className="quota-filter-button" aria-pressed={accountStatus === status} onClick={() => { setAccountStatus(status); setPage(1); }}>
            {status[0]!.toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      {loading && !accounts && <Skeleton rows={3} />}
      {error && <Notice kind="error">Failed to load quota: {error}</Notice>}
      {accounts && accounts.length === 0 && !loading && (
        <Card className="quota-empty"><Icon>data_usage</Icon><div><strong>No Codex connections</strong><p>Quota tracking is available for Codex connections only.</p></div></Card>
      )}
      {accounts && accounts.map((account) => (
        <Card key={account.connectionId} className="quota-card">
          <div className="quota-card-head">
            <div><strong>{account.connectionName}</strong>{account.plan && <small>{account.plan}</small>}</div>
            <div className="quota-card-status">
              <Badge variant={account.active ? "success" : "default"} dot>{account.active ? "Active" : "Inactive"}</Badge>
              {account.stale && <Badge variant="warning">Stale</Badge>}
              <Button variant="ghost" size="sm" icon="sync" onClick={() => void refreshOne(account.connectionId)} disabled={refreshing} aria-label={`Refresh ${account.connectionName}`}>Refresh</Button>
            </div>
          </div>
          {account.error && <Notice kind="error">{account.error}</Notice>}
          {account.quotas.map((quota) => (
            <div key={quota.id} className="quota-window">
              <div className="quota-window-label"><span>{quota.label}</span><small>{quota.remainingPercent}% remaining</small></div>
              <div className="quota-bar" role="progressbar" aria-valuenow={quota.usedPercent} aria-valuemin={0} aria-valuemax={100}>
                <div className="quota-bar-fill" style={{ width: `${quota.usedPercent}%` }} />
              </div>
              {quota.resetAt && <small>Resets {new Date(quota.resetAt).toLocaleString()}</small>}
            </div>
          ))}
        </Card>
      ))}
      {pagination && pagination.totalPages > 1 && (
        <div className="pagination">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span>Page {page} of {pagination.totalPages}</span>
          <Button variant="ghost" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </section>
  );
}
