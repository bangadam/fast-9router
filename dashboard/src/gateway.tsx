import { useState } from "preact/hooks";
import { get, send, ApiError, type GatewaySettings } from "./api.ts";
import { Notice, useAsync, useToast } from "./app.tsx";
import { Badge, Button, Card, Icon, Input, Modal, SectionHeader, Skeleton, Toggle } from "./primitives.tsx";

export function GatewayScreen() {
  const { data, error, loading, refresh } = useAsync(() => get<GatewaySettings>("/api/admin/gateway"), []);
  const notify = useToast();
  const [keyModal, setKeyModal] = useState(false);
  const [enforceModal, setEnforceModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const endpoint = `${location.origin}/v1`;

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

  return (
    <section>
      <SectionHeader title="Local API endpoint" description="Use this OpenAI-compatible base URL in local clients and developer tools." />
      {loading && <Skeleton rows={4} />}
      {error && <Notice kind="error">Failed to load gateway settings: {error}</Notice>}
      {data && <>
        <Card class="endpoint-card">
          <div class="endpoint-card-top"><span class="endpoint-icon"><Icon>lan</Icon></span><div><span class="eyebrow">Local endpoint</span><h3>Fast 9Router Gateway</h3></div><Badge variant="success" dot>Reachable</Badge></div>
          <div class="endpoint-value"><code>{endpoint}</code><Button variant="secondary" icon="content_copy" onClick={copyEndpoint}>Copy Endpoint</Button></div>
          <div class="endpoint-meta"><span><Icon>computer</Icon>Available from this machine</span><span><Icon>{data.enforce ? "lock" : "lock_open"}</Icon>{data.enforce ? "Gateway key required" : "No key required"}</span></div>
        </Card>

        <div class="settings-grid">
          <Card class="settings-card">
            <div class="settings-card-title"><span class="settings-icon"><Icon>key</Icon></span><div><h3>Gateway key</h3><p>Authentication credential for requests to <code>/v1/*</code>.</p></div></div>
            <div class="setting-row"><div><strong>{data.keyConfigured ? "Key configured" : "No key configured"}</strong><small>{data.keyConfigured ? data.keyMasked : "Create a key before requiring authentication."}</small></div><Badge variant={data.keyConfigured ? "success" : "warning"}>{data.keyConfigured ? "Configured" : "Not configured"}</Badge></div>
            <Button variant="secondary" icon={data.keyConfigured ? "sync" : "add"} onClick={() => setKeyModal(true)}>{data.keyConfigured ? "Rotate Key" : "Set Key"}</Button>
          </Card>

          <Card class="settings-card">
            <div class="settings-card-title"><span class="settings-icon"><Icon>shield_lock</Icon></span><div><h3>Key enforcement</h3><p>Require the configured gateway key for every API request.</p></div></div>
            {!data.keyConfigured && <Notice kind="warning">Set a gateway key before enabling enforcement.</Notice>}
            {data.enforceRequired && <Notice kind="warning">Enforcement is required while the server listens on a non-loopback address.</Notice>}
            <div class="setting-row"><div><strong>{data.enforce ? "Enforcement on" : "Enforcement off"}</strong><small>{data.enforce ? "Clients must provide the gateway key." : "Local clients can call the API without a key."}</small></div><Toggle checked={data.enforce} disabled={data.enforceRequired || (!data.keyConfigured && !data.enforce)} label="Gateway key enforcement" onChange={(enforce) => enforce ? setEnforceModal(true) : updateEnforcement(false)} /></div>
          </Card>
        </div>
      </>}

      <KeyModal isOpen={keyModal} configured={Boolean(data?.keyConfigured)} onClose={() => setKeyModal(false)} onSaved={() => { setKeyModal(false); refresh(); notify("Gateway key updated.", "success"); }} onError={(message) => notify(message, "error")} />
      <Modal isOpen={enforceModal} onClose={() => setEnforceModal(false)} title="Enable key enforcement" size="sm" closeOnOverlay={!busy} footer={<><Button variant="ghost" disabled={busy} onClick={() => setEnforceModal(false)}>Cancel</Button><Button loading={busy} onClick={() => updateEnforcement(true)}>Enable Enforcement</Button></>}><div class="security-warning"><Icon>warning</Icon><div><strong>Clients will need the gateway key</strong><p>Existing requests without an Authorization key will be rejected after this change.</p></div></div></Modal>
    </section>
  );
}

function KeyModal({ isOpen, configured, onClose, onSaved, onError }: { isOpen: boolean; configured: boolean; onClose: () => void; onSaved: () => void; onError: (message: string) => void }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await send("/api/admin/gateway/key", "PUT", { key: key.trim() });
      setKey("");
      onSaved();
    } catch (reason) {
      onError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return <Modal isOpen={isOpen} onClose={onClose} title={configured ? "Rotate Gateway Key" : "Set Gateway Key"} size="sm"><form class="modal-form" onSubmit={save}><p class="modal-copy">Use at least 8 characters. The key is stored locally and shown only in masked form after saving.</p><Input required minlength={8} type="password" autocomplete="new-password" label="New gateway key" value={key} placeholder="At least 8 characters" onInput={(event) => setKey((event.target as HTMLInputElement).value)} /><div class="modal-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={saving}>{configured ? "Rotate Key" : "Save Key"}</Button></div></form></Modal>;
}
