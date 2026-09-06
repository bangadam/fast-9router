import { useState } from "react";
import { get, send, ApiError, type GatewaySettings, type GatewayKeyDto, type CreatedGatewayKey } from "./api.ts";
import { Notice, useAsync, useToast } from "./app.tsx";
import { Badge, Button, Card, ConfirmModal, Icon, Input, Modal, SectionHeader, Skeleton, Toggle } from "./primitives.tsx";

export function GatewayScreen() {
  const { data, error, loading, refresh } = useAsync(() => get<GatewaySettings>("/api/admin/gateway"), []);
  const notify = useToast();
  const [createModal, setCreateModal] = useState(false);
  const [enforceModal, setEnforceModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renameKey, setRenameKey] = useState<GatewayKeyDto | null>(null);
  const [pauseKey, setPauseKey] = useState<GatewayKeyDto | null>(null);
  const [deleteKey, setDeleteKey] = useState<GatewayKeyDto | null>(null);
  const [secretModal, setSecretModal] = useState<CreatedGatewayKey | null>(null);
  const [rowPending, setRowPending] = useState<string | null>(null);
  const endpoint = `${location.origin}/v1`;

  const keyConfigured = Boolean(data?.keys.some((key) => key.isActive));

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      notify("Endpoint copied.", "success");
    } catch {
      notify("Clipboard access was unavailable.", "error");
    }
  };

  const updateEnforcement = async (enforce: boolean) => {
    setBusy(true);
    try {
      await send("/api/admin/gateway/enforce", "PUT", { enforce });
      refresh();
      setEnforceModal(false);
      notify(`Key enforcement ${enforce ? "enabled" : "disabled"}.`, "success");
    } catch (reason) {
      notify(reason instanceof ApiError ? reason.message : String(reason), "error");
    } finally {
      setBusy(false);
    }
  };

  const patchKey = async (key: GatewayKeyDto, patch: { name?: string; isActive?: boolean }) => {
    setRowPending(key.id);
    try {
      await send(`/api/admin/gateway/keys/${key.id}`, "PATCH", patch);
      setRenameKey(null);
      setPauseKey(null);
      refresh();
      notify("Gateway key updated.", "success");
    } catch (reason) {
      notify(reason instanceof ApiError ? reason.message : String(reason), "error");
    } finally {
      setRowPending(null);
    }
  };

  const removeKey = async (key: GatewayKeyDto) => {
    setRowPending(key.id);
    try {
      await send(`/api/admin/gateway/keys/${key.id}`, "DELETE");
      setDeleteKey(null);
      refresh();
      notify("Gateway key deleted.", "success");
    } catch (reason) {
      notify(reason instanceof ApiError ? reason.message : String(reason), "error");
    } finally {
      setRowPending(null);
    }
  };

  const copySecret = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      notify("Secret copied.", "success");
    } catch {
      notify("Clipboard access was unavailable.", "error");
    }
  };

  return (
    <section>
      <SectionHeader title="Local API endpoint" description="Use this [OI]-compatible base URL in local clients and developer tools." />
      {loading && <Skeleton rows={4} />}
      {error && <Notice kind="error">Failed to load gateway settings: {error}</Notice>}
      {data && <>
        <Card className="endpoint-card">
          <div className="endpoint-card-top"><span className="endpoint-icon"><Icon>lan</Icon></span><div><span className="eyebrow">Local endpoint</span><h3>Fast 9Router Gateway</h3></div><Badge variant="success" dot>Reachable</Badge></div>
          <div className="endpoint-value"><code>{endpoint}</code><Button variant="secondary" icon="content_copy" onClick={copyEndpoint}>Copy Endpoint</Button></div>
          <div className="endpoint-meta"><span><Icon>computer</Icon>Available from this machine</span><span><Icon>{data.enforce ? "lock" : "lock_open"}</Icon>{data.enforce ? "Gateway key required" : "No key required"}</span></div>
        </Card>

        <div className="settings-grid">
          <Card className="settings-card">
            <div className="settings-card-title"><span className="settings-icon"><Icon>key</Icon></span><div><h3>Gateway API keys</h3><p>Named credentials for requests to <code>/v1/*</code>. Bearer or <code>x-api-key</code>.</p></div></div>
            {!keyConfigured && <Notice kind="warning">Create an active key before requiring authentication.</Notice>}
            <div className="gateway-key-list">
              {data.keys.length === 0 && <p className="gateway-key-empty">No gateway keys yet. Create one to authenticate API clients.</p>}
              {data.keys.map((key) => (
                <div key={key.id} className="gateway-key-row">
                  <div className="gateway-key-info">
                    <strong>{key.name}</strong>
                    <small><code>{key.keyMasked}</code></small>
                    <small>Created {new Date(key.createdAt).toLocaleDateString()}</small>
                  </div>
                  <Badge variant={key.isActive ? "success" : "warning"}>{key.isActive ? "Active" : "Paused"}</Badge>
                  <div className="gateway-key-actions">
                    <Button variant="ghost" size="sm" disabled={rowPending === key.id} onClick={() => setRenameKey(key)} aria-label={`Rename ${key.name}`}>Rename</Button>
                    <Button variant="ghost" size="sm" disabled={rowPending === key.id} onClick={() => (key.isActive ? setPauseKey(key) : patchKey(key, { isActive: true }))}>{key.isActive ? "Pause" : "Activate"}</Button>
                    <Button variant="ghost" size="sm" className="button-danger" disabled={rowPending === key.id} onClick={() => setDeleteKey(key)} aria-label={`Delete ${key.name}`}>Delete</Button>
                  </div>
                </div>
              ))}
            </div>
            <Button variant="secondary" icon="add" onClick={() => setCreateModal(true)}>Create Key</Button>
          </Card>

          <Card className="settings-card">
            <div className="settings-card-title"><span className="settings-icon"><Icon>shield_lock</Icon></span><div><h3>Key enforcement</h3><p>Require an active gateway key for every API request.</p></div></div>
            {!keyConfigured && <Notice kind="warning">Create a gateway key before enabling enforcement.</Notice>}
            {data.enforceRequired && <Notice kind="warning">Enforcement is required while the server listens on a non-loopback address.</Notice>}
            <div className="setting-row"><div><strong>{data.enforce ? "Enforcement on" : "Enforcement off"}</strong><small>{data.enforce ? "Clients must provide an active gateway key." : "Local clients can call the API without a key."}</small></div><Toggle checked={data.enforce} disabled={data.enforceRequired || (!keyConfigured && !data.enforce)} label="Gateway key enforcement" onChange={(enforce) => enforce ? setEnforceModal(true) : updateEnforcement(false)} /></div>
          </Card>
        </div>
      </>}

      <CreateKeyModal
        isOpen={createModal}
        onClose={() => setCreateModal(false)}
        onCreated={(created) => {
          setCreateModal(false);
          refresh();
          notify("Gateway key created.", "success");
          setSecretModal(created);
        }}
        onError={(message) => notify(message, "error")}
      />
      <SecretModal created={secretModal} onClose={() => setSecretModal(null)} onCopy={copySecret} />
      <RenameKeyModal keyDto={renameKey} onClose={() => setRenameKey(null)} onSaved={(key, name) => patchKey(key, { name })} />
      <ConfirmModal
        isOpen={pauseKey !== null}
        onClose={() => setPauseKey(null)}
        onConfirm={() => { if (pauseKey) void patchKey(pauseKey, { isActive: false }); }}
        title="Pause gateway key"
        message={`Requests using "${pauseKey?.name ?? ""}" will be rejected until the key is reactivated.`}
        confirmText="Pause Key"
        variant="danger"
        loading={rowPending === pauseKey?.id}
      />
      <ConfirmModal
        isOpen={deleteKey !== null}
        onClose={() => setDeleteKey(null)}
        onConfirm={() => { if (deleteKey) void removeKey(deleteKey); }}
        title="Delete gateway key"
        message={`This permanently deletes "${deleteKey?.name ?? ""}". Existing clients using it will stop authenticating.`}
        confirmText="Delete Key"
        variant="danger"
        loading={rowPending === deleteKey?.id}
      />
      <Modal isOpen={enforceModal} onClose={() => setEnforceModal(false)} title="Enable key enforcement" size="sm" closeOnOverlay={!busy} footer={<><Button variant="ghost" disabled={busy} onClick={() => setEnforceModal(false)}>Cancel</Button><Button loading={busy} onClick={() => updateEnforcement(true)}>Enable Enforcement</Button></>}><div className="security-warning"><Icon>warning</Icon><div><strong>Clients will need a gateway key</strong><p>Existing requests without an Authorization key will be rejected after this change.</p></div></div></Modal>
    </section>
  );
}

function CreateKeyModal({ isOpen, onClose, onCreated, onError }: { isOpen: boolean; onClose: () => void; onCreated: (created: CreatedGatewayKey) => void; onError: (message: string) => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const created = await send<CreatedGatewayKey>("/api/admin/gateway/keys", "POST", { name: name.trim() });
      setName("");
      onCreated(created);
    } catch (reason) {
      onError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return <Modal isOpen={isOpen} onClose={onClose} title="Create Gateway Key" size="sm"><form className="modal-form" onSubmit={save}><p className="modal-copy">Name the key so usage attribution stays readable. The secret is shown once at creation.</p><Input required maxLength={80} label="Key name" value={name} placeholder="e.g. laptop-claude-code" onInput={(event) => setName((event.target as HTMLInputElement).value)} /><div className="modal-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={saving} disabled={name.trim() === ""}>Create Key</Button></div></form></Modal>;
}

function SecretModal({ created, onClose, onCopy }: { created: CreatedGatewayKey | null; onClose: () => void; onCopy: (secret: string) => Promise<void> }) {
  if (!created) return null;
  return <Modal isOpen onClose={onClose} title="Save your gateway key" size="sm" footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button icon="content_copy" onClick={() => void onCopy(created.secret)}>Copy Secret</Button></>}>
    <div className="security-warning"><Icon>warning</Icon><div><strong>This secret cannot be shown again</strong><p>Copy it into your client configuration now. Only a SHA-256 hash is stored.</p></div></div>
    <div className="gateway-secret"><code>{created.secret}</code></div>
  </Modal>;
}

function RenameKeyModal({ keyDto, onClose, onSaved }: { keyDto: GatewayKeyDto | null; onClose: () => void; onSaved: (key: GatewayKeyDto, name: string) => void }) {
  const [name, setName] = useState("");
  const current = keyDto?.name ?? "";
  const value = name === "" ? current : name;
  if (!keyDto) return null;
  return <Modal isOpen onClose={onClose} title="Rename gateway key" size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={value.trim() === "" || value.trim() === current} onClick={() => onSaved(keyDto, value.trim())}>Save Name</Button></>}>
    <Input required maxLength={80} label="Key name" value={value} onInput={(event) => setName((event.target as HTMLInputElement).value)} />
  </Modal>;
}
