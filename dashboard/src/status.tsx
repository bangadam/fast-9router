import { Fragment } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  get,
  type AnalyticsAccount,
  type AnalyticsEndpoint,
  type AnalyticsModel,
  type CostBreakdown,
  type LiveUsage,
  type Provider,
  type RequestDetailsResponse,
  type RequestUsageDetail,
  type UsageChartPoint,
  type UsagePeriod,
  type UsageStats,
} from "./api.ts";
import { Notice } from "./app.tsx";
import { Badge, Button, Card, Icon, ProviderIcon, Skeleton } from "./primitives.tsx";

const PERIODS: Array<{ value: UsagePeriod; label: string }> = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

type UsageTab = "overview" | "details";
type TableView = "model" | "account" | "apiKey" | "endpoint";
type ValueMode = "costs" | "tokens";
type SortOrder = "asc" | "desc";
type ProviderOption = { id: string; name: string };
type TableItem = {
  key: string;
  group: string;
  model: string;
  provider: string;
  account: string;
  endpoint: string;
  requests: number;
  lastUsed: number | null;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  failures: number;
  cost: CostBreakdown;
};

function fmt(value: number | null | undefined): string {
  return new Intl.NumberFormat().format(value ?? 0);
}
function fmtCost(value: number | null | undefined): string {
  return `$${(value ?? 0).toFixed(2)}`;
}
function fmtTime(timestamp: number | null): string {
  if (!timestamp) return "Never";
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}
function usageTabFromHash(): UsageTab {
  return new URLSearchParams(location.hash.split("?", 2)[1] ?? "").get("tab") === "details" ? "details" : "overview";
}
function setUsageHash(tab: UsageTab, sortBy?: string, sortOrder?: SortOrder): void {
  const params = new URLSearchParams(location.hash.split("?", 2)[1] ?? "");
  params.set("tab", tab);
  if (sortBy) params.set("sortBy", sortBy);
  if (sortOrder) params.set("sortOrder", sortOrder);
  location.hash = `#/status?${params}`;
}

export function StatusScreen() {
  const [tab, setTab] = useState<UsageTab>(usageTabFromHash);
  const [period, setPeriod] = useState<UsagePeriod>("today");
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [chart, setChart] = useState<UsageChartPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const loaded = useRef(false);

  useEffect(() => {
    const onHash = () => setTab(usageTabFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (tab !== "overview") return;
    const controller = new AbortController();
    if (loaded.current) setFetching(true);
    else setLoading(true);
    setError("");
    Promise.all([
      get<UsageStats>(`/api/admin/usage/stats?period=${period}`),
      get<UsageChartPoint[]>(`/api/admin/usage/chart?period=${period}`),
    ]).then(([nextStats, nextChart]) => {
      if (controller.signal.aborted) return;
      loaded.current = true;
      setStats(nextStats);
      setChart(nextChart);
    }).catch((reason: Error) => {
      if (!controller.signal.aborted) setError(reason.message);
    }).finally(() => {
      if (!controller.signal.aborted) { setLoading(false); setFetching(false); }
    });
    return () => controller.abort();
  }, [period, tab]);

  useEffect(() => {
    const events = new EventSource("/api/admin/usage/stream");
    events.onmessage = (event) => {
      try {
        const live = JSON.parse(event.data) as LiveUsage;
        setStats((current) => current ? { ...current, ...live } : current);
      } catch { /* ignore malformed event */ }
    };
    return () => events.close();
  }, []);

  const switchTab = (next: UsageTab) => {
    if (next === tab) return;
    setTab(next);
    setUsageHash(next);
  };

  return (
    <section className="legacy-usage-page">
      <div className="usage-toolbar">
        <Segmented options={[{ value: "overview", label: "Overview" }, { value: "details", label: "Details" }]} value={tab} onChange={(value) => switchTab(value as UsageTab)} />
        {tab === "overview" && <div className="period-fetch"><Segmented options={PERIODS} value={period} onChange={(value) => setPeriod(value as UsagePeriod)} small disabled={fetching} />{fetching && <Icon className="spin">progress_activity</Icon>}</div>}
      </div>
      <div key={tab} className="usage-tab-panel">
        {tab === "overview" ? (
          loading ? <UsageLoading /> : error || !stats ? <Notice kind="error">Failed to load usage statistics{error ? `: ${error}` : "."}</Notice> : <UsageOverview stats={stats} chart={chart} />
        ) : <RequestDetails />}
      </div>
    </section>
  );
}

function Segmented({ options, value, onChange, small = false, disabled = false }: { options: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void; small?: boolean; disabled?: boolean }) {
  return <div className={`segmented ${small ? "is-small" : ""}`}>{options.map((option) => <button key={option.value} type="button" disabled={disabled} aria-pressed={value === option.value} className={value === option.value ? "is-selected" : ""} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

function UsageLoading() {
  return <><div className="usage-kpis">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} rows={1} />)}</div><div className="usage-loading-center"><Icon className="spin">progress_activity</Icon><span>Loading usage...</span></div></>;
}

function UsageOverview({ stats, chart }: { stats: UsageStats; chart: UsageChartPoint[] }) {
  const [tableView, setTableView] = useState<TableView>("model");
  const [valueMode, setValueMode] = useState<ValueMode>("costs");
  return <div className="usage-overview">
    <OverviewCards stats={stats} />
    <div className="usage-operational-grid"><ProviderTopology stats={stats} /><RecentRequests requests={stats.recentRequests} /></div>
    <UsageChart data={chart} />
    <div className="usage-breakdown-toolbar">
      <select value={tableView} onChange={(event) => setTableView((event.target as HTMLSelectElement).value as TableView)}><option value="model">Usage by Model</option><option value="account">Usage by Account</option><option value="apiKey">Usage by API Key</option><option value="endpoint">Usage by Endpoint</option></select>
      <Segmented options={[{ value: "costs", label: "Costs" }, { value: "tokens", label: "Tokens" }]} value={valueMode} onChange={(value) => setValueMode(value as ValueMode)} small />
    </div>
    <UsageTable stats={stats} tableView={tableView} valueMode={valueMode} />
  </div>;
}

function OverviewCards({ stats }: { stats: UsageStats }) {
  const values = [
    ["Total Requests", fmt(stats.summary.requests), "neutral"],
    ["Total Input Tokens", fmt(stats.summary.promptTokens), "input"],
    ["Cached Tokens", fmt(stats.summary.cachedTokens), "cached"],
    ["Output Tokens", fmt(stats.summary.completionTokens), "output"],
    ["Est. Cost", `~${fmtCost(stats.summary.estimatedCost)}`, "cost"],
  ] as const;
  return <div className="usage-kpis">{values.map(([label, value, tone]) => <Card key={label} className={`usage-kpi usage-kpi-${tone}`}><span>{label}</span><strong>{value}</strong>{tone === "cost" && <small>Estimated, not actual billing</small>}</Card>)}</div>;
}

const PROVIDER_COLOR: Record<Provider, string> = { codex: "#000000", anthropic: "#737373", openai: "#a3a3a3" };
function ProviderTopology({ stats }: { stats: UsageStats }) {
  const rawActive = useMemo(() => new Set(stats.activeRequests.map((request) => request.provider.toLowerCase())), [stats.activeRequests]);
  const firstSeen = useRef<Record<string, number>>({});
  const [tick, setTick] = useState(0);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  useEffect(() => {
    const now = Date.now();
    for (const provider of rawActive) firstSeen.current[provider] ??= now;
    for (const provider of Object.keys(firstSeen.current)) if (!rawActive.has(provider)) delete firstSeen.current[provider];
  }, [rawActive]);
  useEffect(() => {
    if (rawActive.size === 0) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [rawActive]);
  const active = useMemo(() => new Set([...rawActive].filter((provider) => Date.now() - (firstSeen.current[provider] ?? Date.now()) < 60_000)), [rawActive, tick]);
  const lastProvider = stats.recentRequests[0]?.provider.toLowerCase() ?? "";
  const errorProvider = stats.errorProvider.toLowerCase();
  const nodes = stats.graph.nodes.map((node, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / Math.max(stats.graph.nodes.length, 1);
    return { ...node, x: 50 + Math.cos(angle) * 36, y: 50 + Math.sin(angle) * 35 };
  });
  return <Card className="topology-card">{nodes.length === 0 ? <div className="topology-empty">No providers connected</div> : <div className="topology-stage" onWheel={(event) => { event.preventDefault(); setViewport((current) => ({ ...current, scale: Math.min(2, Math.max(.5, current.scale - event.deltaY * .001)) })); }} onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY, startX: viewport.x, startY: viewport.y }; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!drag.current) return; setViewport((current) => ({ ...current, x: drag.current!.startX + event.clientX - drag.current!.x, y: drag.current!.startY + event.clientY - drag.current!.y })); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}><div className="topology-canvas" style={{ transform: `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.scale})` }}><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{nodes.map((node) => { const isActive = active.has(node.id); const isError = !isActive && errorProvider === node.id; const isLast = !isActive && !isError && lastProvider === node.id; const path = `M 50 50 Q ${(50 + node.x) / 2 + (node.y - 50) * .14} ${(50 + node.y) / 2 - (node.x - 50) * .14} ${node.x} ${node.y}`; return <g key={node.id} className={`topology-edge ${isActive ? "is-active" : isError ? "is-error" : isLast ? "is-last" : ""}`}><path className="edge-halo" d={path} /><path className="edge-core" d={path} />{isActive && Array.from({ length: 6 }, (_, index) => <circle key={index} r={index % 2 ? 1.7 : 2.4}><animateMotion dur={`${.55 + index * .07}s`} repeatCount="indefinite" begin={`${index * .08}s`} {...{ path }} /></circle>)}</g>; })}</svg><div className={`topology-router ${active.size ? "is-active" : ""}`} style={{ left: "50%", top: "50%" }}><span><Icon>hub</Icon></span><strong>Fast 9Router</strong>{active.size > 0 && <b>{active.size}</b>}</div>{nodes.map((node) => { const on = active.has(node.id); return <div key={node.id} className={`topology-node ${on ? "is-active" : ""}`} style={{ left: `${node.x}%`, top: `${node.y}%`, "--provider-color": PROVIDER_COLOR[node.provider] } as React.CSSProperties}><ProviderIcon provider={node.provider} alt={`${node.name} logo`} size={28} /><strong>{node.name}</strong>{on && <span className="active-pulse" />}</div>; })}</div><div className="graph-controls"><button aria-label="Zoom in" onClick={() => setViewport((current) => ({ ...current, scale: Math.min(2, current.scale + .15) }))}><Icon>add</Icon></button><button aria-label="Zoom out" onClick={() => setViewport((current) => ({ ...current, scale: Math.max(.5, current.scale - .15) }))}><Icon>remove</Icon></button><button aria-label="Fit graph" onClick={() => setViewport({ x: 0, y: 0, scale: 1 })}><Icon>fullscreen</Icon></button></div></div>}</Card>;
}

function RecentRequests({ requests }: { requests: LiveUsage["recentRequests"] }) {
  const [, setTick] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => setTick((value) => value + 1), 1_000); return () => window.clearInterval(timer); }, []);
  return <Card className="recent-card"><div className="recent-head"><h3>Recent Requests</h3></div><div className="recent-columns"><span>Model</span><span>In / Out</span><span>When</span></div><div className="recent-list">{requests.length === 0 ? <div className="topology-empty">No requests yet.</div> : requests.map((request, index) => <div className="recent-row" key={`${request.timestamp}-${index}`}><span className={`request-dot ${request.status === "error" ? "is-error" : ""}`} /><strong title={request.model}>{request.model.includes("/") ? request.model.slice(request.model.indexOf("/") + 1) : request.model}</strong><span className="recent-tokens"><b>{fmt(request.promptTokens)}↑</b> <i>{fmt(request.completionTokens)}↓</i></span><time>{timeAgo(request.timestamp)}</time></div>)}</div></Card>;
}
function timeAgo(timestamp: number): string { const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000)); if (seconds < 60) return `${seconds}s ago`; if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`; return `${Math.floor(seconds / 86_400)}d ago`; }

function UsageChart({ data }: { data: UsageChartPoint[] }) {
  const [mode, setMode] = useState<"tokens" | "cost">("tokens");
  const [hover, setHover] = useState<number | null>(null);
  const values = data.map((point) => mode === "tokens" ? point.tokens : point.cost);
  const max = Math.max(...values, 1);
  const coords = values.map((value, index) => ({ x: 54 + index * (900 / Math.max(values.length - 1, 1)), y: 224 - value / max * 176 }));
  const line = coords.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ");
  const area = coords.length ? `${line} L${coords.at(-1)!.x} 224 L54 224 Z` : "";
  const selected = hover === null ? null : data[hover];
  return <Card className="usage-chart-card"><Segmented options={[{ value: "tokens", label: "Tokens" }, { value: "cost", label: "Cost" }]} value={mode} onChange={(value) => { setMode(value as "tokens" | "cost"); setHover(null); }} small />{data.every((point) => point.tokens === 0 && point.cost === 0) ? <div className="chart-empty">No data for this period</div> : <div className="chart-wrap" onPointerLeave={() => setHover(null)} onPointerMove={(event) => { const rect = event.currentTarget.getBoundingClientRect(); const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)); setHover(Math.round(ratio * (data.length - 1))); }}><svg className="usage-chart" viewBox="0 0 1000 260" role="img" aria-label={`${mode} usage chart`}><defs><linearGradient id={`usage-${mode}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stop-color={mode === "tokens" ? "#6366f1" : "#f59e0b"} stop-opacity=".25" /><stop offset="95%" stop-color={mode === "tokens" ? "#6366f1" : "#f59e0b"} stop-opacity="0" /></linearGradient></defs>{[0,.25,.5,.75,1].map((fraction) => <g key={fraction}><line x1="54" x2="954" y1={224-fraction*176} y2={224-fraction*176} /><text x="46" y={228-fraction*176} text-anchor="end">{mode === "tokens" ? compact(max*fraction) : `$${(max*fraction).toFixed(4)}`}</text></g>)}<path className="chart-area" d={area} fill={`url(#usage-${mode})`} /><path key={mode} className={`chart-line chart-line-${mode}`} d={line} />{coords.map((point,index) => index % Math.max(1,Math.ceil(coords.length/8))===0 && <text key={index} x={point.x} y="249" text-anchor="middle">{data[index]!.label}</text>)}{hover !== null && <><line className="chart-cursor" x1={coords[hover]!.x} x2={coords[hover]!.x} y1="48" y2="224" /><circle className={`chart-dot chart-dot-${mode}`} cx={coords[hover]!.x} cy={coords[hover]!.y} r="4" /></>}</svg>{selected && <div className="chart-tooltip" style={{ left: `${coords[hover!]!.x/10}%`, top: `${coords[hover!]!.y/2.6}%` }}><strong>{selected.label}</strong><span>{mode === "tokens" ? `${fmt(selected.tokens)} tokens` : `$${selected.cost.toFixed(4)}`}</span></div>}</div>}</Card>;
}
function compact(value: number): string { return value >= 1_000_000 ? `${(value/1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value/1_000).toFixed(1)}K` : String(Math.round(value)); }

function UsageTable({ stats, tableView, valueMode }: { stats: UsageStats; tableView: TableView; valueMode: ValueMode }) {
  const params = new URLSearchParams(location.hash.split("?", 2)[1] ?? "");
  const [sortBy, setSortBy] = useState(params.get("sortBy") || "group");
  const [sortOrder, setSortOrder] = useState<SortOrder>(params.get("sortOrder") === "desc" ? "desc" : "asc");
  const storageKey = `usage-stats:expanded-${tableView}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(storageKey) || "[]") as string[]); } catch { return new Set(); } });
  useEffect(() => { try { setExpanded(new Set(JSON.parse(localStorage.getItem(storageKey) || "[]") as string[])); } catch { setExpanded(new Set()); } }, [storageKey]);
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify([...expanded])); }, [expanded, storageKey]);
  const items = useMemo(() => tableItems(stats, tableView), [stats, tableView]);
  const groups = useMemo(() => groupTableItems(items).sort((a, b) => compareGroups(a, b, sortBy, sortOrder)), [items, sortBy, sortOrder]);
  const sort = (field: string) => { const order: SortOrder = sortBy === field && sortOrder === "asc" ? "desc" : "asc"; setSortBy(field); setSortOrder(order); setUsageHash("overview", field, order); };
  const identityColumns = tableView === "model" ? [{ field: "group", label: "Model" }, { field: "provider", label: "Provider" }, { field: "requests", label: "Requests" }, { field: "lastUsed", label: "Last Used" }] : tableView === "account" ? [{ field: "group", label: "Account" }, { field: "model", label: "Model" }, { field: "provider", label: "Provider" }, { field: "requests", label: "Requests" }, { field: "lastUsed", label: "Last Used" }] : tableView === "apiKey" ? [{ field: "group", label: "API Key Name" }, { field: "model", label: "Model" }, { field: "provider", label: "Provider" }, { field: "requests", label: "Requests" }, { field: "lastUsed", label: "Last Used" }] : [{ field: "group", label: "Endpoint" }, { field: "model", label: "Model" }, { field: "provider", label: "Provider" }, { field: "requests", label: "Requests" }, { field: "lastUsed", label: "Last Used" }];
  const valueColumns = valueMode === "costs" ? [{ field: "inputCost", label: "Input Cost" }, { field: "cachedCost", label: "Cached Cost" }, { field: "outputCost", label: "Output Cost" }, { field: "totalCost", label: "Total Cost" }] : [{ field: "promptTokens", label: "Input Tokens" }, { field: "cachedTokens", label: "Cached" }, { field: "completionTokens", label: "Output Tokens" }, { field: "totalTokens", label: "Total Tokens" }];
  return <Card className="analytics-table-card"><div className="table-wrap"><table className="data-table legacy-usage-table"><thead><tr>{identityColumns.map(({ field, label }) => <th key={field} className={field === "requests" ? "num" : ""}><button onClick={() => sort(field)}>{label}<SortIcon field={field} sortBy={sortBy} order={sortOrder} /></button></th>)}{valueColumns.map(({ field, label }) => <th key={field} className="num"><button onClick={() => sort(field)}>{label}<SortIcon field={field} sortBy={sortBy} order={sortOrder} /></button></th>)}</tr></thead><tbody>{groups.map((group) => { const open = expanded.has(group.group); return <Fragment key={group.group}><tr className="group-summary" onClick={() => { const next = new Set(expanded); open ? next.delete(group.group) : next.add(group.group); setExpanded(next); }}><td><span className={`disclosure ${open ? "is-open" : ""}`}><Icon>arrow_forward</Icon></span><strong>{group.group}</strong></td>{summaryIdentityCells(tableView)}<td className="num">{fmt(group.requests)}</td><td>{fmtTime(group.lastUsed)}</td><ValueCells item={group} mode={valueMode} /></tr>{open && group.items.map((item) => <tr key={item.key} className="group-detail">{detailIdentityCells(item, tableView)}<td className="num">{fmt(item.requests)}</td><td>{fmtTime(item.lastUsed)}</td><ValueCells item={item} mode={valueMode} /></tr>)}</Fragment>; })}{groups.length === 0 && <tr><td className="table-empty" colSpan={identityColumns.length + 4}>No usage recorded yet.</td></tr>}</tbody></table></div></Card>;
}
function SortIcon({field,sortBy,order}:{field:string;sortBy:string;order:SortOrder}){return <span className={sortBy===field?"":"is-muted"}>{sortBy===field?(order==="asc"?"↑":"↓"):"↕"}</span>;}
function tableItems(stats: UsageStats, view: TableView): TableItem[] {
  if (view === "model") return stats.models.flatMap((model) => model.providers.map((provider) => ({ key: `${model.model}:${provider.connectionId}`, group: model.model, model: model.model, provider: provider.provider, account: provider.connectionName, endpoint: "", requests: provider.requests, lastUsed: provider.lastUsed, promptTokens: provider.promptTokens ?? 0, cachedTokens: provider.cachedTokens ?? 0, completionTokens: provider.completionTokens ?? 0, failures: provider.failures, cost: provider.cost })));
  if (view === "account") return stats.accounts.map((item) => ({ key: `${item.connectionId}:${item.model}`, group: item.connectionName, model: item.model, provider: item.provider, account: item.connectionName, endpoint: "", requests: item.requests, lastUsed: item.lastUsed, promptTokens: item.promptTokens ?? 0, cachedTokens: item.cachedTokens ?? 0, completionTokens: item.completionTokens ?? 0, failures: item.failures, cost: item.cost }));
  if (view === "apiKey") return stats.apiKeys.map((item) => ({ key: `${item.keyName}:${item.model}:${item.connectionId}`, group: item.keyName, model: item.model, provider: item.provider, account: item.keyName, endpoint: "", requests: item.requests, lastUsed: item.lastUsed, promptTokens: item.promptTokens ?? 0, cachedTokens: item.cachedTokens ?? 0, completionTokens: item.completionTokens ?? 0, failures: item.failures, cost: item.cost }));
  return stats.endpoints.map((item) => ({ key: `${item.endpoint}:${item.model}:${item.connectionId}`, group: item.endpoint, model: item.model, provider: item.provider, account: item.connectionName, endpoint: item.endpoint, requests: item.requests, lastUsed: item.lastUsed, promptTokens: item.promptTokens ?? 0, cachedTokens: item.cachedTokens ?? 0, completionTokens: item.completionTokens ?? 0, failures: item.failures, cost: item.cost }));
}
function groupTableItems(items:TableItem[]){const groups=new Map<string,TableItem&{items:TableItem[]}>();for(const item of items){const group=groups.get(item.group)??{...item,key:item.group,requests:0,promptTokens:0,cachedTokens:0,completionTokens:0,failures:0,cost:{input:0,cached:0,output:0,total:0},lastUsed:null,items:[]};group.requests+=item.requests;group.promptTokens+=item.promptTokens;group.cachedTokens+=item.cachedTokens;group.completionTokens+=item.completionTokens;group.failures+=item.failures;group.cost.input+=item.cost.input;group.cost.cached+=item.cost.cached;group.cost.output+=item.cost.output;group.cost.total+=item.cost.total;group.lastUsed=Math.max(group.lastUsed??0,item.lastUsed??0)||null;group.items.push(item);groups.set(item.group,group);}return[...groups.values()];}
function compareGroups(a:ReturnType<typeof groupTableItems>[number],b:ReturnType<typeof groupTableItems>[number],field:string,order:SortOrder){const value=(item:typeof a):string|number=>{switch(field){case"group":return item.group.toLowerCase();case"model":return item.model.toLowerCase();case"provider":return item.provider.toLowerCase();case"requests":return item.requests;case"lastUsed":return item.lastUsed??0;case"inputCost":return item.cost.input;case"cachedCost":return item.cost.cached;case"outputCost":return item.cost.output;case"totalCost":return item.cost.total;case"promptTokens":return item.promptTokens;case"cachedTokens":return item.cachedTokens;case"completionTokens":return item.completionTokens;default:return item.promptTokens+item.completionTokens;}};const av=value(a),bv=value(b),result=av<bv?-1:av>bv?1:0;return order==="asc"?result:-result;}
function summaryIdentityCells(view:TableView){return view==="model"?<td>–</td>:<><td>–</td><td>–</td></>;}
function detailIdentityCells(item:TableItem,view:TableView){return view==="model"?<><td>{item.model}</td><td><Badge>{item.provider}</Badge><small>{item.account}</small></td></>:view==="account"||view==="apiKey"?<><td>{item.account}</td><td>{item.model}</td><td><Badge>{item.provider}</Badge></td></>:<><td><code>{item.endpoint}</code></td><td>{item.model}</td><td><Badge>{item.provider}</Badge></td></>;}
function ValueCells({item,mode}:{item:TableItem;mode:ValueMode}){return mode==="costs"?<><td className="num">{fmtCost(item.cost.input)}</td><td className="num">{item.cost.cached?fmtCost(item.cost.cached):"–"}</td><td className="num">{fmtCost(item.cost.output)}</td><td className="num total-cost">{fmtCost(item.cost.total)}</td></>:<><td className="num">{fmt(item.promptTokens)}</td><td className="num">{item.cachedTokens?fmt(item.cachedTokens):"–"}</td><td className="num">{fmt(item.completionTokens)}</td><td className="num">{fmt(item.promptTokens+item.completionTokens)}</td></>;}

function RequestDetails(){const[providers,setProviders]=useState<ProviderOption[]>([]);const[filters,setFilters]=useState({provider:"",startDate:"",endDate:""});const[page,setPage]=useState(1);const[pageSize,setPageSize]=useState(20);const[data,setData]=useState<RequestDetailsResponse|null>(null);const[loading,setLoading]=useState(true);const[error,setError]=useState("");const[selected,setSelected]=useState<RequestUsageDetail|null>(null);useEffect(()=>{get<{providers:ProviderOption[]}>("/api/admin/usage/providers").then(result=>setProviders(result.providers)).catch(()=>{});},[]);useEffect(()=>{const params=new URLSearchParams({page:String(page),pageSize:String(pageSize)});if(filters.provider)params.set("provider",filters.provider);if(filters.startDate)params.set("startDate",filters.startDate);if(filters.endDate)params.set("endDate",filters.endDate);setLoading(true);setError("");get<RequestDetailsResponse>(`/api/admin/usage/request-details?${params}`).then(setData).catch((reason:Error)=>setError(reason.message)).finally(()=>setLoading(false));},[page,pageSize,filters]);return <div className="request-details"><Card className="details-filter-card"><label><span>Provider</span><select value={filters.provider} onChange={event=>{setPage(1);setFilters({...filters,provider:(event.target as HTMLSelectElement).value});}}><option value="">All Providers</option>{providers.map(provider=><option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label><span>Start Date</span><input type="datetime-local" value={filters.startDate} onInput={event=>{setPage(1);setFilters({...filters,startDate:(event.target as HTMLInputElement).value});}}/></label><label><span>End Date</span><input type="datetime-local" value={filters.endDate} onInput={event=>{setPage(1);setFilters({...filters,endDate:(event.target as HTMLInputElement).value});}}/></label><Button variant="ghost" disabled={!filters.provider&&!filters.startDate&&!filters.endDate} onClick={()=>{setPage(1);setFilters({provider:"",startDate:"",endDate:""});}}>Clear Filters</Button></Card>{error&&<Notice kind="error">Failed to fetch request details: {error}</Notice>}<Card className="details-table-card"><div className="table-wrap"><table className="data-table request-details-table"><thead><tr><th>Timestamp</th><th>Model</th><th>Provider</th><th className="num">Input Tokens</th><th className="num">Cached</th><th className="num">Output Tokens</th><th>Latency</th><th>Action</th></tr></thead><tbody>{loading?<tr><td colSpan={8} className="table-empty"><Icon className="spin">progress_activity</Icon> Loading...</td></tr>:data?.details.length?data.details.map(detail=><tr key={detail.id}><td>{new Date(detail.createdAt).toLocaleString()}</td><td><code>{detail.model}</code></td><td>{detail.provider}</td><td className="num">{fmt(detail.promptTokens)}</td><td className="num">{detail.cachedTokens?fmt(detail.cachedTokens):"–"}</td><td className="num">{fmt(detail.completionTokens)}</td><td><small>TTFT: {detail.ttftMs??0}ms</small><br/><small>Total: {detail.latencyMs??0}ms</small></td><td><Button variant="secondary" size="sm" onClick={()=>setSelected(detail)}>Detail</Button></td></tr>):<tr><td colSpan={8} className="table-empty">No request details found</td></tr>}</tbody></table></div>{data&&data.pagination.totalItems>0&&<div className="pagination"><label>Rows <select value={pageSize} onChange={event=>{setPage(1);setPageSize(Number((event.target as HTMLSelectElement).value));}}>{[20,50,100].map(size=><option key={size}>{size}</option>)}</select></label><span>{data.pagination.totalItems.toLocaleString()} records</span><Button variant="ghost" size="sm" disabled={page<=1} onClick={()=>setPage(value=>value-1)}>Previous</Button><span>Page {page} of {Math.max(data.pagination.totalPages,1)}</span><Button variant="ghost" size="sm" disabled={page>=data.pagination.totalPages} onClick={()=>setPage(value=>value+1)}>Next</Button></div>}</Card><DetailDrawer detail={selected} onClose={()=>setSelected(null)}/></div>;}
function DetailDrawer({ detail, onClose }: { detail: RequestUsageDetail | null; onClose: () => void }) {
  const [shown, setShown] = useState<RequestUsageDetail | null>(detail);
  const [closing, setClosing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (detail) {
      setShown(detail);
      setClosing(false);
      return;
    }
    if (!shown) return;
    setClosing(true);
    const timer = window.setTimeout(() => { setShown(null); setClosing(false); }, 160);
    return () => window.clearTimeout(timer);
  }, [detail, shown]);

  useEffect(() => {
    if (!shown) return;
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() => closeRef.current?.focus());
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") { event.preventDefault(); closeRef.current?.focus(); }
    };
    addEventListener("keydown", key);
    return () => { removeEventListener("keydown", key); previous?.focus(); };
  }, [shown, onClose]);

  if (!shown) return null;
  const fields: Array<[string, string | number]> = [
    ["ID", shown.id], ["Timestamp", new Date(shown.createdAt).toLocaleString()], ["Provider", shown.provider],
    ["Model", shown.model], ["Status", shown.status], ["Endpoint", shown.endpoint ?? "Unknown"],
    ["Connection", shown.connectionName], ["API Key", shown.keyName],
    ["TTFT", shown.ttftMs === null ? "Unknown" : `${shown.ttftMs}ms`],
    ["Total latency", shown.latencyMs === null ? "Unknown" : `${shown.latencyMs}ms`],
    ["Input tokens", fmt(shown.promptTokens)], ["Cached tokens", shown.cachedTokens ? fmt(shown.cachedTokens) : "–"],
    ["Output tokens", fmt(shown.completionTokens)],
  ];
  return <div className={`drawer-layer ${closing ? "is-closing" : ""}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="Request Details"><header><h2>Request Details</h2><button ref={closeRef} aria-label="Close request details" onClick={onClose}><Icon>close</Icon></button></header><dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><div className="drawer-safety"><Icon>shield_lock</Icon><p>Prompts, tool arguments, headers, and response bodies are not stored.</p></div></aside></div>;
}
