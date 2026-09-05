import { useMemo, useRef, useState } from "preact/hooks";
import { get, send, ApiError, type Alias, type MaskedConnection, type Provider } from "./api.ts";
import { Notice, useAsync, useToast } from "./app.tsx";
import { Badge, Button, Card, ConfirmModal, Icon, Input, Modal, ProviderIcon, SectionHeader, Skeleton, Toggle } from "./primitives.tsx";

interface FormState { name: string; prefix: string; baseUrl: string; apiKey: string; clearApiKey: boolean; models: string; priority: string; isActive: boolean }
const EMPTY_FORM: FormState = { name: "", prefix: "", baseUrl: "", apiKey: "", clearApiKey: false, models: "", priority: "0", isActive: true };
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const PROVIDERS: Record<Provider, { label: string; description: string; learnMore: string; prefix: string }> = {
  codex: { label: "OpenAI Codex", description: "ChatGPT OAuth", learnMore: "https://chatgpt.com/", prefix: "cx" },
  anthropic: { label: "Anthropic", description: "Official Anthropic API", learnMore: "https://console.anthropic.com/", prefix: "anthropic" },
  openai: { label: "OpenAI-compatible", description: "OpenAI and compatible endpoints", learnMore: "https://platform.openai.com/", prefix: "oa" },
};
type Filter = "all" | "connected" | "error" | "not-ready" | "disconnected";
type TestResult = { ok: boolean; error?: string };
type ProviderModel = { id: string; name: string; disabled: boolean };

function parseModels(raw: string): string[] {
  return [...new Set(raw.split(/[,\n]/).map((model) => model.trim()).filter(Boolean))];
}
function formFromConnection(connection: MaskedConnection): FormState {
  return { name: connection.name, prefix: connection.data.prefix ?? "", baseUrl: connection.data.baseUrl ?? "", apiKey: "", clearApiKey: false, models: (connection.data.models ?? []).join(", "), priority: String(connection.priority), isActive: connection.isActive };
}
function message(reason: unknown): string {
  return reason instanceof ApiError ? reason.message : String(reason);
}
function connectionStatus(connection: MaskedConnection, result?: TestResult): { label: string; variant: "default" | "success" | "error" } {
  const error = result?.ok === false ? result.error : connection.lastError;
  if (!connection.isActive) return { label: "Disabled", variant: "default" };
  if (error) return { label: "Error", variant: "error" };
  if (result?.ok) return { label: "Connected", variant: "success" };
  return connection.routable ? { label: "Ready", variant: "success" } : { label: "Not ready", variant: "default" };
}

export function ConnectionsScreen({ provider }: { provider?: Provider } = {}) {
  return provider ? <ProviderDetail provider={provider} /> : <ProviderOverview />;
}

function ProviderOverview() {
  const { data, error, loading } = useAsync(() => get<{ connections: MaskedConnection[] }>("/api/admin/connections"), []);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editor, setEditor] = useState<MaskedConnection | "new" | null>(null);
  const notify = useToast();
  const connections = data?.connections ?? [];
  const visibleProviders = useMemo(() => (Object.keys(PROVIDERS) as Provider[]).filter((provider) => {
    const rows = connections.filter((connection) => connection.provider === provider);
    const meta = PROVIDERS[provider];
    const textMatch = `${meta.label} ${meta.description} ${rows.map((row) => row.name).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase());
    const statusMatch = filter === "all" || rows.some((row) => {
      const status = connectionStatus(row).label;
      return filter === "connected" ? status === "Ready" : filter === "error" ? status === "Error" : filter === "not-ready" ? status === "Not ready" : status === "Disabled";
    });
    return textMatch && statusMatch;
  }), [connections, filter, query]);

  return <section>
    <SectionHeader title="Providers" description="Choose a provider to manage its connections and models." action={<Button icon="add" onClick={() => setEditor("new")}>Add Provider</Button>} />
    <div class="provider-toolbar">
      <Input aria-label="Search providers" icon="search" placeholder="Search providers..." value={query} onInput={(event) => setQuery((event.target as HTMLInputElement).value)} />
      <label class="compact-select"><span class="visually-hidden">Filter by status</span><select value={filter} onChange={(event) => setFilter((event.target as HTMLSelectElement).value as Filter)}><option value="all">All</option><option value="connected">Ready</option><option value="error">Error</option><option value="not-ready">Not ready</option><option value="disconnected">Disabled</option></select></label>
    </div>
    {loading && <div class="provider-grid"><Skeleton rows={2} /><Skeleton rows={2} /><Skeleton rows={2} /></div>}
    {error && <Notice kind="error">Failed to load providers: {error}</Notice>}
    {!loading && !error && visibleProviders.length === 0 && <Notice kind="empty">No providers match the current filters.</Notice>}
    <div class="provider-grid">{!loading && !error && visibleProviders.map((provider) => {
      const rows = connections.filter((connection) => connection.provider === provider);
      const ready = rows.filter((row) => connectionStatus(row).label === "Ready").length;
      const errors = rows.filter((row) => connectionStatus(row).label === "Error").length;
      const meta = PROVIDERS[provider];
      return <a class="card provider-card provider-link" href={`#/providers/${provider}`} key={provider}>
        <div class="provider-card-head"><ProviderIcon provider={provider} alt={`${meta.label} logo`} size={42} /><div><h3>{meta.label}</h3><p>{meta.description}</p></div><Icon>open_in_new</Icon><div class="provider-status">{ready > 0 && <Badge variant="success" dot>{ready} Ready</Badge>}{errors > 0 && <Badge variant="error" dot>{errors} Error</Badge>}{rows.length === 0 && <Badge>No connections</Badge>}</div></div>
        <div class="provider-card-foot"><span>{rows.length} connection{rows.length === 1 ? "" : "s"}</span><span>Manage <Icon>arrow_forward</Icon></span></div>
      </a>;
    })}</div>
    <ConnectionModal value={editor} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); location.hash = "#/connections"; location.reload(); }} onError={(value) => notify(value, "error")} onOAuth={startCodexOAuth(notify)} />
  </section>;
}

function startCodexOAuth(notify: ReturnType<typeof useToast>) {
  return async () => {
    try {
      const { authorizeUrl } = await get<{ authorizeUrl: string }>("/api/admin/oauth/codex/start");
      location.assign(authorizeUrl);
    } catch (reason) {
      notify(message(reason), "error");
    }
  };
}

function ProviderDetail({ provider }: { provider: Provider }) {
  const connectionsState = useAsync(() => get<{ connections: MaskedConnection[] }>("/api/admin/connections"), [provider]);
  const modelsState = useAsync(() => get<{ models: ProviderModel[] }>(`/api/admin/providers/${provider}/models`), [provider]);
  const aliasesState = useAsync(() => get<{ aliases: Alias[] }>("/api/admin/aliases"), [provider]);
  const notify = useToast();
  const stopTests = useRef(false);
  const [editor, setEditor] = useState<MaskedConnection | "new" | null>(null);
  const [deleting, setDeleting] = useState<MaskedConnection | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busyId, setBusyId] = useState<number | null>(null);
  const [modelConnectionId, setModelConnectionId] = useState<number | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [testResults, setTestResults] = useState<Record<number, TestResult>>({});
  const [newModel, setNewModel] = useState("");
  const [thinkingMode, setThinkingMode] = useState("auto");
  const [modelBusy, setModelBusy] = useState(false);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [deletingAlias, setDeletingAlias] = useState<Alias | null>(null);
  const meta = PROVIDERS[provider];
  const connections = (connectionsState.data?.connections ?? []).filter((connection) => connection.provider === provider).sort((a, b) => a.priority - b.priority || a.id - b.id);
  const models = modelsState.data?.models ?? [];
  const targetConnection = connections.find((connection) => connection.id === modelConnectionId) ?? connections.find((connection) => connection.isActive) ?? connections[0];
  const roundRobin = connections.length > 1 && connections.every((connection) => connection.priority === connections[0]!.priority);
  const providerPrefixes = new Set(provider === "openai" ? connections.map((connection) => connection.data.prefix).filter(Boolean) : [meta.prefix]);
  const aliases = (aliasesState.data?.aliases ?? []).filter((alias) => providerPrefixes.has(alias.target.split("/", 1)[0]));
  const refresh = () => { connectionsState.refresh(); modelsState.refresh(); aliasesState.refresh(); };
  const oauth = startCodexOAuth(notify);

  const act = async (id: number, action: () => Promise<unknown>, success?: string) => {
    setBusyId(id);
    try { await action(); refresh(); if (success) notify(success, "success"); }
    catch (reason) { notify(message(reason), "error"); }
    finally { setBusyId(null); }
  };
  const testConnection = async (connection: MaskedConnection, quiet = false) => {
    setBusyId(connection.id);
    try {
      const result = await send<TestResult>(`/api/admin/connections/${connection.id}/test`, "POST");
      setTestResults((current) => ({ ...current, [connection.id]: result }));
      if (!quiet) notify(result.ok ? `${connection.name} connected.` : `${connection.name}: ${result.error ?? "Connection failed."}`, result.ok ? "success" : "error");
      return result;
    } catch (reason) {
      const error = message(reason);
      setTestResults((current) => ({ ...current, [connection.id]: { ok: false, error } }));
      if (!quiet) notify(error, "error");
      return { ok: false, error };
    } finally { setBusyId(null); connectionsState.refresh(); }
  };
  const testOneByOne = async () => {
    stopTests.current = false; setTestingAll(true);
    let passed = 0;
    for (const connection of connections) {
      if (stopTests.current) break;
      if ((await testConnection(connection, true)).ok) passed++;
    }
    notify(stopTests.current ? `Stopped after ${passed} successful test${passed === 1 ? "" : "s"}.` : `${passed}/${connections.length} connections passed.`, stopTests.current || passed < connections.length ? "info" : "success");
    setTestingAll(false);
  };
  const reorder = async (index: number, delta: number) => {
    const other = index + delta;
    if (other < 0 || other >= connections.length || roundRobin) return;
    const next = [...connections];
    [next[index], next[other]] = [next[other]!, next[index]!];
    try {
      await send("/api/admin/connections/priorities", "POST", { priorities: next.map((connection, priority) => ({ id: connection.id, priority })) });
      connectionsState.refresh();
    } catch (reason) { notify(message(reason), "error"); }
  };
  const setRoundRobin = async (enabled: boolean) => {
    try {
      await send("/api/admin/connections/priorities", "POST", { priorities: connections.map((connection, index) => ({ id: connection.id, priority: enabled ? 0 : index })) });
      connectionsState.refresh();
      notify(enabled ? "Round robin enabled for this provider." : "Priority routing enabled for this provider.", "success");
    } catch (reason) { notify(message(reason), "error"); }
  };
  const updateTargetModels = async (next: string[]) => {
    if (!targetConnection) throw new Error("Add a connection before configuring models.");
    await send(`/api/admin/connections/${targetConnection.id}`, "PATCH", { data: { ...targetConnection.data, models: [...new Set(next)].sort() } });
    refresh();
  };
  const normalizeModel = (value: string) => {
    const trimmed = value.trim();
    const prefix = provider === "openai" ? targetConnection?.data.prefix : meta.prefix;
    return prefix && trimmed.startsWith(`${prefix}/`) ? trimmed.slice(prefix.length + 1) : trimmed;
  };
  const modelOnTarget = (id: string): string | null => {
    if (!targetConnection) return null;
    const prefix = provider === "openai" ? targetConnection.data.prefix : meta.prefix;
    if (!prefix || !id.startsWith(`${prefix}/`)) return null;
    const upstream = id.slice(prefix.length + 1);
    return targetConnection.data.models?.includes(upstream) ? upstream : null;
  };
  const removeModel = async (id: string) => {
    const upstream = modelOnTarget(id);
    if (!upstream) return;
    setModelBusy(true);
    try { await updateTargetModels((targetConnection?.data.models ?? []).filter((model) => model !== upstream)); notify(`${id} removed from ${targetConnection?.name}.`, "success"); }
    catch (reason) { notify(message(reason), "error"); }
    finally { setModelBusy(false); }
  };
  const addModel = async () => {
    const model = normalizeModel(newModel);
    if (!model || model.includes("/")) return notify("Enter one upstream model ID without another provider prefix.", "error");
    setModelBusy(true);
    try { await updateTargetModels([...(targetConnection?.data.models ?? []), model]); setNewModel(""); notify(`${model} added.`, "success"); }
    catch (reason) { notify(message(reason), "error"); }
    finally { setModelBusy(false); }
  };
  const importModels = async () => {
    if (!targetConnection || provider === "codex") return;
    setModelBusy(true);
    try {
      const result = await send<{ models: string[] }>(`/api/admin/connections/${targetConnection.id}/models`, "POST");
      await updateTargetModels([...(targetConnection.data.models ?? []), ...result.models]);
      notify(`${result.models.length} model IDs imported from /models.`, "success");
    } catch (reason) { notify(message(reason), "error"); }
    finally { setModelBusy(false); }
  };
  const setVisibility = async (ids: string[], disabled: boolean) => {
    setModelBusy(true);
    try { await send("/api/admin/models/visibility", "POST", { models: ids, disabled }); modelsState.refresh(); notify(disabled ? "Models disabled." : "Models enabled.", "success"); }
    catch (reason) { notify(message(reason), "error"); }
    finally { setModelBusy(false); }
  };
  const displayModel = (id: string) => thinkingMode === "auto" ? id : `${id}(${thinkingMode})`;
  const copy = async (id: string) => {
    try { await navigator.clipboard.writeText(displayModel(id)); notify("Model ID copied.", "success"); }
    catch { notify("Clipboard access was unavailable.", "error"); }
  };

  return <section class="provider-detail">
    <a class="back-link" href="#/connections"><Icon>arrow_back</Icon>Back to Providers</a>
    <div class="provider-detail-head"><ProviderIcon provider={provider} alt={`${meta.label} logo`} size={54} /><div><h2>{meta.label}</h2><p>{connections.length} connection{connections.length === 1 ? "" : "s"}</p></div><a class="learn-link" href={meta.learnMore} target="_blank" rel="noreferrer"><Icon>open_in_new</Icon>Sign up / Learn more</a></div>
    {provider === "codex" && <Notice kind="warning" icon="warning">Risk Notice: This provider uses a subscription/OAuth session not officially licensed for proxy/router use. Account may be restricted or banned. Use at your own risk.</Notice>}
    <Card class="provider-detail-card">
      <div class="detail-card-head"><div><h3>Connections</h3><p>Priority, health, and availability for this provider.</p></div><div class="detail-actions">{connections.length > 0 && <Button variant="secondary" size="sm" icon="sync" loading={testingAll} onClick={testOneByOne}>Test Connection One-by-One</Button>}{testingAll && <Button variant="ghost" size="sm" icon="stop" onClick={() => { stopTests.current = true; }}>Stop</Button>}<label class="round-robin"><span>Round Robin</span><Toggle checked={roundRobin} label="Round robin" disabled={connections.length < 2 || testingAll} onChange={setRoundRobin} /></label></div></div>
      {connectionsState.loading && <Skeleton rows={3} />}
      {connectionsState.error && <Notice kind="error">Failed to load connections: {connectionsState.error}</Notice>}
      {!connectionsState.loading && connections.length === 0 && <div class="provider-empty-detail"><Icon>{provider === "codex" ? "lock" : "key"}</Icon><span>No connections yet</span><Button size="sm" onClick={() => provider === "codex" ? oauth() : setEditor("new")}>Add Connection</Button></div>}
      {connections.length > 0 && <><label class="select-all"><input type="checkbox" checked={selected.size === connections.length} onChange={() => setSelected(selected.size === connections.length ? new Set() : new Set(connections.map((connection) => connection.id)))} />Select All</label><div class="detail-connections">{connections.map((connection, index) => {
        const status = connectionStatus(connection, testResults[connection.id]);
        return <div class={`detail-connection-row ${connection.isActive ? "" : "is-inactive"}`} key={connection.id}>
          <input class="row-select" aria-label={`Select ${connection.name}`} type="checkbox" checked={selected.has(connection.id)} onChange={() => { const next = new Set(selected); next.has(connection.id) ? next.delete(connection.id) : next.add(connection.id); setSelected(next); }} />
          <div class="priority-arrows"><button disabled={index === 0 || roundRobin} aria-label={`Move ${connection.name} up`} onClick={() => reorder(index, -1)}><Icon>keyboard_arrow_up</Icon></button><button disabled={index === connections.length - 1 || roundRobin} aria-label={`Move ${connection.name} down`} onClick={() => reorder(index, 1)}><Icon>keyboard_arrow_down</Icon></button></div>
          <Icon>{provider === "codex" ? "lock" : "key"}</Icon>
          <div class="detail-connection-main"><strong>{connection.data.email || connection.name}</strong>{connection.data.email && connection.data.email !== connection.name && <small>{connection.name}</small>}<div><Badge variant={status.variant} dot>{status.label}</Badge><Badge>{provider === "codex" ? "OAuth" : "API Key"}</Badge><span>#{connection.priority}</span></div>{(testResults[connection.id]?.error || connection.lastError) && <small class="row-error">{testResults[connection.id]?.error || connection.lastError}</small>}</div>
          <div class="detail-row-actions"><button onClick={() => testConnection(connection)} disabled={busyId === connection.id}><Icon>{busyId === connection.id ? "progress_activity" : "network_check"}</Icon><span>Test</span></button><button class={connection.data.autoPing ? "is-active" : ""} title="After an observed rate-limit cooldown resets, send one minimal request. Disables itself if that request fails." onClick={() => act(connection.id, () => send(`/api/admin/connections/${connection.id}`, "PATCH", { data: { autoPing: !connection.data.autoPing } }), `Auto-ping ${connection.data.autoPing ? "disabled" : "enabled"}.`)}><Icon>bolt</Icon><span>Auto-ping</span></button><button onClick={() => setEditor(connection)}><Icon>edit</Icon><span>Edit</span></button><button class="danger-action" onClick={() => setDeleting(connection)}><Icon>delete</Icon><span>Delete</span></button><Toggle checked={connection.isActive} label={`${connection.isActive ? "Disable" : "Enable"} ${connection.name}`} disabled={busyId === connection.id} onChange={(active) => act(connection.id, () => send(`/api/admin/connections/${connection.id}/${active ? "activate" : "deactivate"}`, "POST"), `${connection.name} ${active ? "enabled" : "disabled"}.`)} /></div>
        </div>;
      })}</div><div class="connection-footer-actions"><Button variant="secondary" size="sm" icon="playlist_add" onClick={() => setBulkOpen(true)}>Bulk Add</Button><Button size="sm" icon="add" onClick={() => provider === "codex" ? oauth() : setEditor("new")}>Add</Button>{selected.size > 0 && <Button variant="danger" size="sm" icon="delete" onClick={async () => { if (!confirm(`Delete ${selected.size} selected connections?`)) return; try { await Promise.all([...selected].map((id) => send(`/api/admin/connections/${id}`, "DELETE"))); setSelected(new Set()); refresh(); } catch (reason) { notify(message(reason), "error"); } }}>Delete Selected ({selected.size})</Button>}</div></>}
    </Card>

    <Card class="provider-detail-card">
      <div class="detail-card-head"><div class="model-title-controls"><div><h3>Available Models</h3><p>Models exposed under this provider namespace.</p></div>{provider !== "anthropic" && <label class="thinking-select"><span class="visually-hidden">Thinking effort</span><select value={thinkingMode} onChange={(event) => setThinkingMode((event.target as HTMLSelectElement).value)}>{["auto", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level} value={level}>Thinking: {level[0]!.toUpperCase() + level.slice(1)}</option>)}</select></label>}</div><div class="detail-actions">{models.some((model) => model.disabled) && <Button variant="secondary" size="sm" icon="restart_alt" disabled={modelBusy} onClick={() => setVisibility(models.filter((model) => model.disabled).map((model) => model.id), false)}>Enable All</Button>}{models.some((model) => !model.disabled) && <Button variant="secondary" size="sm" icon="block" disabled={modelBusy} onClick={() => setVisibility(models.filter((model) => !model.disabled).map((model) => model.id), true)}>Disable All</Button>}</div></div>
      <div class="model-add-row"><Input label="Model ID" value={newModel} placeholder={provider === "anthropic" ? "claude-3-opus-20240229" : provider === "codex" ? "gpt-5.6-sol" : "gpt-4o"} onInput={(event) => setNewModel((event.target as HTMLInputElement).value)} onKeyDown={(event) => { if (event.key === "Enter") addModel(); }} />{provider === "openai" && connections.length > 1 && <label class="field"><span class="field-label">Target connection</span><select value={targetConnection?.id ?? ""} onChange={(event) => setModelConnectionId(Number((event.target as HTMLSelectElement).value))}>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {connection.data.prefix}</option>)}</select></label>}<Button size="sm" icon="add" disabled={!targetConnection || !newModel.trim()} loading={modelBusy} onClick={addModel}>Add</Button>{provider !== "codex" && <Button variant="secondary" size="sm" icon="download" disabled={!targetConnection} loading={modelBusy} onClick={importModels}>Import from /models</Button>}</div>
      {modelsState.loading && <Skeleton rows={4} />}{modelsState.error && <Notice kind="error">Failed to load models: {modelsState.error}</Notice>}
      {!modelsState.loading && models.length === 0 && <Notice kind="empty">No models configured.</Notice>}
      <div class="provider-model-grid">{models.map((model) => <div class={`provider-model ${model.disabled ? "is-disabled" : ""}`} key={model.id}><Icon>smart_toy</Icon><div><strong>{displayModel(model.id)}</strong><small>{model.name}</small></div><Button variant="ghost" size="icon" icon="content_copy" aria-label={`Copy ${displayModel(model.id)}`} onClick={() => copy(model.id)} />{modelOnTarget(model.id) && <Button variant="ghost" size="icon" icon="close" aria-label={`Remove ${model.id} from ${targetConnection?.name}`} onClick={() => removeModel(model.id)} />}<button class="model-visibility" aria-label={`${model.disabled ? "Enable" : "Disable"} ${model.id}`} onClick={() => setVisibility([model.id], !model.disabled)}>{model.disabled ? "Enable" : "Disable"}</button></div>)}</div>
      <div class="model-panel-foot"><Button variant="secondary" size="sm" icon="alternate_email" disabled={models.length === 0} onClick={() => setAliasOpen(true)}>Add Alias</Button></div>
    </Card>

    {aliases.length > 0 && <Card class="provider-detail-card"><div class="detail-card-head"><div><h3>Aliases</h3><p>Friendly IDs pointing to this provider.</p></div></div><div class="alias-list">{aliases.map((alias) => <div key={alias.id}><code>{alias.name}</code><span>{alias.target}</span><Button variant="ghost" size="icon" icon="delete" aria-label={`Delete ${alias.name}`} onClick={() => setDeletingAlias(alias)} /></div>)}</div></Card>}

    <ConnectionModal value={editor} fixedProvider={provider} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); refresh(); notify("Provider saved.", "success"); }} onError={(value) => notify(value, "error")} onOAuth={oauth} />
    <BulkConnectionModal provider={provider} template={targetConnection} isOpen={bulkOpen} onClose={() => setBulkOpen(false)} onSaved={() => { setBulkOpen(false); refresh(); }} onError={(value) => notify(value, "error")} />
    <AliasModal isOpen={aliasOpen} models={models.map((model) => model.id)} onClose={() => setAliasOpen(false)} onSaved={() => { setAliasOpen(false); aliasesState.refresh(); notify("Alias saved.", "success"); }} onError={(value) => notify(value, "error")} />
    <ConfirmModal isOpen={deleting !== null} onClose={() => setDeleting(null)} title="Delete connection" message={<>Delete <strong>{deleting?.name}</strong>? Requests can no longer route through it.</>} loading={deleting !== null && busyId === deleting.id} onConfirm={async () => { if (!deleting) return; await act(deleting.id, () => send(`/api/admin/connections/${deleting.id}`, "DELETE"), `${deleting.name} deleted.`); setDeleting(null); }} />
    <ConfirmModal isOpen={deletingAlias !== null} onClose={() => setDeletingAlias(null)} title="Delete alias" message={<>Delete <strong>{deletingAlias?.name}</strong>?</>} onConfirm={async () => { if (!deletingAlias) return; try { await send(`/api/admin/aliases/${encodeURIComponent(deletingAlias.name)}`, "DELETE"); setDeletingAlias(null); aliasesState.refresh(); } catch (reason) { notify(message(reason), "error"); } }} />
  </section>;
}

function ConnectionModal({ value, fixedProvider, onClose, onSaved, onError, onOAuth }: { value: MaskedConnection | "new" | null; fixedProvider?: Provider; onClose: () => void; onSaved: () => void; onError: (message: string) => void; onOAuth: () => Promise<void> }) {
  const editing = value !== null && value !== "new";
  const [provider, setProvider] = useState<Provider>(editing ? value.provider : fixedProvider ?? "codex");
  const [form, setForm] = useState<FormState>(editing ? formFromConnection(value) : EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const patch = (next: Partial<FormState>) => setForm((current) => ({ ...current, ...next }));
  const submit = async (event: Event) => {
    event.preventDefault(); setSubmitting(true);
    try {
      const body: Record<string, unknown> = { name: form.name.trim(), priority: Number(form.priority) || 0, isActive: form.isActive };
      if (provider === "anthropic") { const data: Record<string, unknown> = { baseUrl: form.baseUrl.trim() || undefined, models: parseModels(form.models) }; if (form.clearApiKey) data.apiKey = null; else if (form.apiKey) data.apiKey = form.apiKey; body.data = data; }
      if (provider === "openai") { const data: Record<string, unknown> = { baseUrl: form.baseUrl.trim() || OPENAI_BASE_URL, prefix: form.prefix.trim(), models: parseModels(form.models) }; if (form.clearApiKey) data.apiKey = null; else if (form.apiKey) data.apiKey = form.apiKey; body.data = data; }
      if (editing) await send(`/api/admin/connections/${value.id}`, "PATCH", body); else await send("/api/admin/connections", "POST", { provider, ...body });
      onSaved();
    } catch (reason) { onError(message(reason)); }
    finally { setSubmitting(false); }
  };
  const isOAuthCreate = !editing && provider === "codex";
  return <Modal key={value === "new" ? `new-${fixedProvider ?? "any"}` : value?.id ?? "closed"} isOpen={value !== null} onClose={onClose} title={editing ? `Edit ${value.name}` : "Add Provider"} size="md">
    {!editing && !fixedProvider && <div class="provider-picker">{(Object.keys(PROVIDERS) as Provider[]).map((id) => <button type="button" key={id} class={provider === id ? "is-selected" : ""} onClick={() => { setProvider(id); setForm(EMPTY_FORM); }}><ProviderIcon provider={id} alt={`${PROVIDERS[id].label} logo`} size={30} /><span><strong>{PROVIDERS[id].label}</strong><small>{PROVIDERS[id].description}</small></span></button>)}</div>}
    {isOAuthCreate ? <div class="oauth-panel"><Icon>lock</Icon><h3>Connect with ChatGPT</h3><p>Fast 9Router opens OpenAI sign-in, then stores the returned local OAuth session.</p><Button icon="login" onClick={onOAuth}>Continue with ChatGPT</Button></div> : <form class="modal-form" onSubmit={submit}>
      <Badge variant="primary">{PROVIDERS[provider].label}</Badge><Input required label="Connection name" value={form.name} placeholder="Production" onInput={(event) => patch({ name: (event.target as HTMLInputElement).value })} />
      {provider === "anthropic" && <><Input label="Base URL" hint="Leave blank for the official Anthropic Messages endpoint." value={form.baseUrl} placeholder="https://api.anthropic.com/v1/messages" onInput={(event) => patch({ baseUrl: (event.target as HTMLInputElement).value })} /><Input type="password" autocomplete="off" label="API key" value={form.apiKey} placeholder={editing && value.data.apiKey ? "Leave blank to keep current key" : "sk-ant-..."} onInput={(event) => patch({ apiKey: (event.target as HTMLInputElement).value })} />{editing && value.data.apiKey && <label class="checkbox-row"><input type="checkbox" checked={form.clearApiKey} onChange={(event) => patch({ clearApiKey: (event.target as HTMLInputElement).checked })} />Clear stored API key</label>}</>}
      {provider === "openai" && <><Input required label="Prefix" hint="Lowercase letters, numbers, or dashes." pattern="[a-z0-9][a-z0-9-]{0,31}" value={form.prefix} placeholder="oa" onInput={(event) => patch({ prefix: (event.target as HTMLInputElement).value })} /><Input required label="Base URL" value={form.baseUrl} placeholder={OPENAI_BASE_URL} onInput={(event) => patch({ baseUrl: (event.target as HTMLInputElement).value })} /><Input type="password" autocomplete="off" label="API key" value={form.apiKey} placeholder={editing && value.data.apiKey ? "Leave blank to keep current key" : "sk-..."} onInput={(event) => patch({ apiKey: (event.target as HTMLInputElement).value })} />{editing && value.data.apiKey && <label class="checkbox-row"><input type="checkbox" checked={form.clearApiKey} onChange={(event) => patch({ clearApiKey: (event.target as HTMLInputElement).checked })} />Clear stored API key</label>}</>}
      <Input label="Priority" hint="Lower values route first; equal values round-robin." type="number" value={form.priority} onInput={(event) => patch({ priority: (event.target as HTMLInputElement).value })} /><div class="setting-row"><div><strong>Active</strong><small>Allow requests through this connection.</small></div><Toggle checked={form.isActive} label="Active connection" onChange={(isActive) => patch({ isActive })} /></div><div class="modal-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={submitting}>Save Provider</Button></div>
    </form>}
  </Modal>;
}

function BulkConnectionModal({ provider, template, isOpen, onClose, onSaved, onError }: { provider: Provider; template?: MaskedConnection; isOpen: boolean; onClose: () => void; onSaved: () => void; onError: (message: string) => void }) {
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      if (provider === "codex") {
        const parsed = JSON.parse(text) as unknown;
        const accounts = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { accounts?: unknown }).accounts) ? (parsed as { accounts: unknown[] }).accounts : [parsed];
        if (accounts.length === 0) throw new Error("No accounts found.");
        for (const [index, raw] of accounts.entries()) {
          if (!raw || typeof raw !== "object") throw new Error(`Account ${index + 1} must be an object.`);
          const account = raw as Record<string, unknown>;
          if (typeof account.accessToken !== "string" || !account.accessToken) throw new Error(`Account ${index + 1} is missing accessToken.`);
          const data = Object.fromEntries(["accessToken", "refreshToken", "idToken", "expiresAt", "accountId", "email", "planType"].flatMap((key) => account[key] === undefined ? [] : [[key, account[key]]]));
          const name = typeof account.email === "string" ? account.email : typeof account.accountId === "string" ? account.accountId : `Codex ${index + 1}`;
          await send("/api/admin/connections", "POST", { provider, name, data });
        }
      } else {
        if (!template) throw new Error("Add one connection first to define the endpoint.");
        const keys = text.split(/\r?\n/).map((key) => key.trim()).filter(Boolean);
        if (keys.length === 0) throw new Error("No API keys found.");
        for (const [index, apiKey] of keys.entries()) {
          const data = provider === "openai"
            ? { baseUrl: template.data.baseUrl, prefix: template.data.prefix, models: template.data.models ?? [], apiKey }
            : { baseUrl: template.data.baseUrl, models: template.data.models ?? [], apiKey };
          await send("/api/admin/connections", "POST", { provider, name: `${template.name} ${index + 2}`, priority: template.priority, data });
        }
      }
      setText(""); onSaved();
    } catch (reason) { onError(message(reason)); }
    finally { setBusy(false); }
  };
  const codex = provider === "codex";
  return <Modal isOpen={isOpen} onClose={onClose} title={`Bulk Add ${PROVIDERS[provider].label}`} size="lg"><div class="modal-form"><p class="field-hint">{codex ? <>Paste a JSON array. Each account must include <code>accessToken</code>; refresh and identity tokens are optional.</> : <>Paste one API key per line. Endpoint, prefix, models, and priority copy from <strong>{template?.name}</strong>.</>}</p><textarea rows={10} value={text} onInput={(event) => setText((event.target as HTMLTextAreaElement).value)} placeholder={codex ? '[{"accessToken":"...","refreshToken":"...","email":"user@example.com"}]' : "sk-key-one\nsk-key-two"} /><div class="modal-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!text.trim()} onClick={submit}>Import All</Button></div></div></Modal>;
}

function AliasModal({ isOpen, models, onClose, onSaved, onError }: { isOpen: boolean; models: string[]; onClose: () => void; onSaved: () => void; onError: (message: string) => void }) {
  const [name, setName] = useState(""); const [target, setTarget] = useState(models[0] ?? ""); const [busy, setBusy] = useState(false);
  const effectiveTarget = target || models[0] || "";
  const save = async (event: Event) => { event.preventDefault(); setBusy(true); try { await send(`/api/admin/aliases/${encodeURIComponent(name.trim())}`, "PUT", { target: effectiveTarget }); setName(""); setTarget(""); onSaved(); } catch (reason) { onError(message(reason)); } finally { setBusy(false); } };
  return <Modal isOpen={isOpen} onClose={onClose} title="Add Model Alias" size="sm"><form class="modal-form" onSubmit={save}><Input required label="Alias name" value={name} placeholder="fast-cheap" onInput={(event) => setName((event.target as HTMLInputElement).value)} /><label class="field"><span class="field-label">Target model</span><select value={effectiveTarget} onChange={(event) => setTarget((event.target as HTMLSelectElement).value)}>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label><div class="modal-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save Alias</Button></div></form></Modal>;
}
