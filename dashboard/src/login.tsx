// Login screen: password auth with lockout countdown and default-password
// warning. Calls /api/auth/status, renders a centered password card, and on
// success hands control back to App via the onAuthenticated callback.

import { useEffect, useState } from "react";
import { get, send, ApiError, type AuthStatus, type AuthSuccess } from "./api.ts";
import { Notice } from "./app.tsx";
import { Button, Card, Icon, Input } from "./primitives.tsx";

type Phase = { loading: true } | { error: string; retry: () => void } | { status: AuthStatus };

export function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [phase, setPhase] = useState<Phase>({ loading: true });
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      get<AuthStatus>("/api/auth/status")
        .then((status) => { if (alive) setPhase({ status }); if (status.authenticated) onAuthenticated(); })
        .catch(() => { if (alive) setPhase({ error: "Could not reach the server. Check that Fast 9Router is running.", retry: load }); });
    };
    load();
    return () => { alive = false; };
  }, [onAuthenticated]);

  useEffect(() => {
    if (retryAfter === null) return;
    const remaining = retryAfter;
    const timer = window.setInterval(() => {
      const next = remaining - 1;
      setRetryAfter(next);
      if (next <= 0) {
        window.clearInterval(timer);
        setRetryAfter(null);
        setError(null);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAfter]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || retryAfter !== null) return;
    setBusy(true);
    setError(null);
    try {
      const success = await send<AuthSuccess>("/api/auth/login", "POST", { password });
      if (success.authenticated) {
        setPassword("");
        onAuthenticated();
        return;
      }
      setError("Invalid password.");
    } catch (reason) {
      if (reason instanceof ApiError) {
        if (reason.status === 429 && reason.retryAfter) {
          setRetryAfter(reason.retryAfter);
          setError(`Too many attempts. Try again in ${reason.retryAfter}s.`);
        } else {
          setError(reason.message);
        }
      } else {
        setError(String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if ("loading" in phase) {
    return <div className="login-shell"><div className="login-loading"><Icon className="spin">progress_activity</Icon><span>Checking session…</span></div></div>;
  }
  if ("error" in phase) {
    return <div className="login-shell"><div className="login-card-wrap"><Card className="login-card"><Notice kind="error">{phase.error}</Notice><Button variant="secondary" onClick={phase.retry}>Retry</Button></Card></div></div>;
  }

  const status = phase.status;
  return (
    <div className="login-shell">
      <div className="login-card-wrap">
        <Card className="login-card">
          <div className="login-brand"><span className="brand-mark"><Icon>hub</Icon></span><strong>Fast 9Router</strong></div>
          <h2>Dashboard sign in</h2>
          {status.usesDefaultPassword && <Notice kind="warning">No password is set yet. The default password is <code>123456</code>. Change it after signing in.</Notice>}
          <form className="login-form" onSubmit={submit}>
            <Input required type="password" autoComplete="current-password" label="Password" value={password} onInput={(event) => setPassword((event.target as HTMLInputElement).value)} />
            {error && <Notice kind="error">{error}</Notice>}
            <div className="login-actions"><Button type="submit" loading={busy} disabled={retryAfter !== null}>Sign In</Button></div>
          </form>
        </Card>
      </div>
    </div>
  );
}
