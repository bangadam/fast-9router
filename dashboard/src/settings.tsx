// Settings screen: password change, backup download/import, and logout.

import { useEffect, useRef, useState } from "react";
import { get, send, requestRaw, ApiError, type AuthStatus, type BackupV1, type BackupImportResult } from "./api.ts";
import { Notice, useAsync, useToast } from "./app.tsx";
import { Button, Card, ConfirmModal, Icon, Input, Modal, SectionHeader, Skeleton } from "./primitives.tsx";

export function SettingsScreen() {
  const notify = useToast();
  const { data: status, error, loading, refresh } = useAsync(() => get<AuthStatus>("/api/auth/status"), []);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordError("New password and confirmation do not match.");
      return;
    }
    setPasswordError(null);
    setPasswordBusy(true);
    try {
      await send("/api/admin/profile/password", "PATCH", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      notify("Password changed. This browser stays signed in; others must sign in again.", "success");
    } catch (reason) {
      setPasswordError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setPasswordBusy(false);
    }
  };

  const logout = async () => {
    try {
      await send("/api/auth/logout", "POST");
    } catch { /* idempotent */ }
    history.replaceState(null, "", "/login");
    dispatchEvent(new CustomEvent("fast9r:unauthorized"));
  };

  return (
    <section>
      <SectionHeader title="Settings" description="Dashboard password, configuration backup, and session management." />
      {loading && <Skeleton rows={3} />}
      {error && <Notice kind="error">Failed to load settings: {error}</Notice>}
      {status && <>
        <Card className="settings-card">
          <div className="settings-card-title"><span className="settings-icon"><Icon>key</Icon></span><div><h3>Password</h3><p>{status.usesDefaultPassword ? "Set a password to protect the dashboard." : "Change the dashboard sign-in password."}</p></div></div>
          {status.usesDefaultPassword && <Notice kind="warning">No password is set. The default is <code>123456</code>.</Notice>}
          <form className="settings-form" onSubmit={changePassword}>
            <Input required type="password" autoComplete="current-password" label="Current password" value={currentPassword} onInput={(event) => setCurrentPassword((event.target as HTMLInputElement).value)} />
            <Input required type="password" autoComplete="new-password" minLength={8} label="New password (8-256 bytes)" value={newPassword} onInput={(event) => setNewPassword((event.target as HTMLInputElement).value)} />
            <Input required type="password" autoComplete="new-password" minLength={8} label="Confirm new password" value={confirmPassword} onInput={(event) => setConfirmPassword((event.target as HTMLInputElement).value)} />
            {passwordError && <Notice kind="error">{passwordError}</Notice>}
            <Button type="submit" loading={passwordBusy} disabled={!currentPassword || !newPassword || !confirmPassword}>Change Password</Button>
          </form>
        </Card>

        <BackupCard notify={notify} />

        <Card className="settings-card">
          <div className="settings-card-title"><span className="settings-icon"><Icon>logout</Icon></span><div><h3>Session</h3><p>{status.authenticated ? "You are signed in on this browser." : "Not signed in."}</p></div></div>
          <div className="setting-row"><div><strong>{status.hasPassword ? "Custom password set" : "Default password in use"}</strong><small>{status.expiresAt ? `Session expires ${new Date(status.expiresAt).toLocaleString()}` : "No active session"}</small></div><Button variant="secondary" icon="logout" onClick={logout}>Sign Out</Button></div>
        </Card>
      </>}
    </section>
  );
}

function BackupCard({ notify }: { notify: (message: string, kind?: "success" | "error" | "info") => void }) {
  const [downloadPassword, setDownloadPassword] = useState("");
  const [downloadModal, setDownloadModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importPassword, setImportPassword] = useState("");
  const [importModal, setImportModal] = useState(false);
  const [importFile, setImportFile] = useState<{ name: string; backup: BackupV1 } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const download = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await requestRaw("/api/admin/backup/export", "POST", { password: downloadPassword });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "fast-9router-backup.json";
      a.click();
      URL.revokeObjectURL(url);
      setDownloadModal(false);
      setDownloadPassword("");
      notify("Backup downloaded.", "success");
    } catch (reason) {
      notify(reason instanceof ApiError ? reason.message : String(reason), "error");
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (event: React.FormEvent) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as BackupV1;
      if (parsed.format !== "fast-9router-backup" || parsed.version !== 1) {
        notify("That file is not a Fast 9Router backup.", "error");
        input.value = "";
        return;
      }
      setImportFile({ name: file.name, backup: parsed });
      setImportModal(true);
    } catch {
      notify("Could not read that backup file.", "error");
      input.value = "";
    }
  };

  const runImport = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!importFile) return;
    setBusy(true);
    try {
      const result = await send<BackupImportResult>("/api/admin/backup/import", "POST", { password: importPassword, backup: importFile.backup });
      notify(`Imported ${result.counts.connections} connections, ${result.counts.aliases} aliases, ${result.counts.gatewayKeys} keys.`, "success");
      setImportModal(false);
      setImportFile(null);
      setImportPassword("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (reason) {
      notify(reason instanceof ApiError ? reason.message : String(reason), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="settings-card">
      <div className="settings-card-title"><span className="settings-icon"><Icon>save</Icon></span><div><h3>Backup</h3><p>Export or import your provider connections, aliases, and gateway keys.</p></div></div>
      <Notice kind="warning">Backups are unencrypted and include provider credentials. Store them securely.</Notice>
      <div className="backup-actions">
        <Button variant="secondary" icon="download" onClick={() => setDownloadModal(true)}>Download Backup</Button>
        <Button variant="secondary" icon="upload" onClick={() => fileRef.current?.click()}>Import Backup</Button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={pickFile} />
      </div>

      <Modal isOpen={downloadModal} onClose={() => setDownloadModal(false)} title="Download Backup" size="sm" closeOnOverlay={!busy} footer={<><Button variant="ghost" disabled={busy} onClick={() => setDownloadModal(false)}>Cancel</Button><Button loading={busy} onClick={download}>Download</Button></>}>
        <form className="modal-form" onSubmit={download}>
          <Input required type="password" autoComplete="current-password" label="Current password" value={downloadPassword} onInput={(event) => setDownloadPassword((event.target as HTMLInputElement).value)} />
        </form>
      </Modal>

      <Modal isOpen={importModal} onClose={() => { setImportModal(false); setImportFile(null); setImportPassword(""); if (fileRef.current) fileRef.current.value = ""; }} title="Confirm Import" size="sm" closeOnOverlay={!busy}>
        <div className="security-warning"><Icon>warning</Icon><div><strong>Import replaces your configuration</strong><p>All connections, aliases, and gateway keys are replaced with <strong>{importFile?.name}</strong>. Usage history and your password are preserved. The backup is unencrypted and contains provider credentials.</p></div></div>
        <form className="modal-form" onSubmit={runImport}>
          <Input required type="password" autoComplete="current-password" label="Current password" value={importPassword} onInput={(event) => setImportPassword((event.target as HTMLInputElement).value)} />
          <div className="modal-actions"><Button type="button" variant="ghost" disabled={busy} onClick={() => setImportModal(false)}>Cancel</Button><Button type="submit" className="button-danger" loading={busy} disabled={!importPassword}>Import</Button></div>
        </form>
      </Modal>
    </Card>
  );
}
