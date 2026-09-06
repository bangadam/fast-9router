import type { ComponentType, ReactNode } from "react";
import { createContext } from "react";
import { useCallback, useContext, useEffect, useState } from "react";
import { get, send, type Provider } from "./api.ts";
import { ConnectionsScreen } from "./connections.tsx";
import { GatewayScreen } from "./gateway.tsx";
import { StatusScreen } from "./status.tsx";
import { CliToolDetailScreen, CliToolsScreen } from "./tools.tsx";
import { LoginScreen } from "./login.tsx";
import { SettingsScreen } from "./settings.tsx";
import { TokenSaverScreen } from "./token-saver.tsx";
import { QuotaScreen } from "./quota.tsx";
import { Badge, Icon, ToastStack, type ToastItem } from "./primitives.tsx";

const ConnectionsOverviewScreen = () => <ConnectionsScreen />;

const SCREENS: Record<string, { nav: string; title: string; description: string; icon: string; component: ComponentType }> = {
  gateway: { nav: "Endpoint & Key", title: "Endpoint", description: "API endpoint and gateway key configuration", icon: "api", component: GatewayScreen },
  connections: { nav: "Providers", title: "Providers", description: "Manage your AI provider connections", icon: "dns", component: ConnectionsOverviewScreen },
  status: { nav: "Usage", title: "Usage & Analytics", description: "Monitor API usage, token consumption, and server health", icon: "bar_chart", component: StatusScreen },
  quota: { nav: "Quota Tracker", title: "Quota Tracker", description: "Live Codex usage windows", icon: "data_usage", component: QuotaScreen },
  tools: { nav: "CLI Tools", title: "CLI Tools", description: "Configure local AI CLI tools to route through this gateway", icon: "terminal", component: CliToolsScreen },
  "token-saver": { nav: "Token Saver", title: "Token Saver", description: "Compress tool output and bias concise responses", icon: "bolt", component: TokenSaverScreen },
  settings: { nav: "Settings", title: "Settings", description: "Password, backup, and session management", icon: "settings", component: SettingsScreen },
};

type ToastKind = ToastItem["kind"];
const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

function currentHash(): string {
  const hash = location.hash.replace(/^#\/?/, "").split("?", 1)[0]!;
  if (hash in SCREENS) return hash;
  if (/^providers\/(codex|anthropic|openai)$/.test(hash)) return hash;
  if (/^tools\/[\w-]+$/.test(hash)) return hash;
  return "gateway";
}

type Theme = "light" | "dark" | "system";
function resolvedTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
}

function ThemeToggle() {
  const stored = localStorage.getItem("fast9r-theme");
  const [theme, setTheme] = useState<Theme>(stored === "light" || stored === "dark" ? stored : "system");
  const choices: Theme[] = ["light", "dark", "system"];

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.classList.toggle("dark", resolvedTheme(theme) === "dark");
      document.documentElement.dataset.theme = theme;
    };
    apply();
    media.addEventListener("change", apply);
    localStorage.setItem("fast9r-theme", theme);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const next = choices[(choices.indexOf(theme) + 1) % choices.length]!;
  const icon = theme === "light" ? "light_mode" : theme === "dark" ? "dark_mode" : "brightness_auto";
  return (
    <button type="button" className="theme-toggle" onClick={() => setTheme(next)} aria-label={`Theme: ${theme}. Switch to ${next}.`} title={`Theme: ${theme}. Switch to ${next}.`}>
      <Icon>{icon}</Icon><span>{theme}</span>
    </button>
  );
}

export function App() {
  const [screen, setScreen] = useState(currentHash);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [serverHealthy, setServerHealthy] = useState<boolean | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [authenticated, setAuthenticated] = useState(false);

  // On initial load, check session: authenticated /login becomes #/gateway;
  // unauthenticated / or any hash stays at /login until login.
  useEffect(() => {
    get<{ authenticated: boolean }>("/api/auth/status")
      .then((status) => {
        if (status.authenticated) {
          setAuthenticated(true);
          if (location.pathname === "/login" || location.pathname === "/") {
            history.replaceState(null, "", "/#/gateway");
            setScreen("gateway");
          }
        } else {
          setAuthenticated(false);
          history.replaceState(null, "", "/login");
        }
      })
      .catch(() => setServerHealthy(false));
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuthenticated(false);
      setScreen("gateway");
      history.replaceState(null, "", "/login");
    };
    addEventListener("fast9r:unauthorized", onUnauthorized);
    return () => removeEventListener("fast9r:unauthorized", onUnauthorized);
  }, []);

  useEffect(() => {
    const onHash = () => {
      setScreen(currentHash());
      setSidebarOpen(false);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  useEffect(() => {
    if (!authenticated) return;
    let alive = true;
    get("/api/admin/status").then(() => alive && setServerHealthy(true)).catch(() => alive && setServerHealthy(false));
    return () => { alive = false; };
  }, [screen, authenticated]);

  const notify = useCallback((message: string, kind: ToastKind = "info") => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, message, kind }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4200);
  }, []);

  if (!authenticated) {
    return (
      <ToastContext.Provider value={notify}>
        <LoginScreen onAuthenticated={() => { setAuthenticated(true); history.replaceState(null, "", "/#/gateway"); setScreen("gateway"); }} />
        <ToastStack items={toasts} dismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
      </ToastContext.Provider>
    );
  }

  const provider = screen.startsWith("providers/") ? screen.slice("providers/".length) as Provider : undefined;
  const cliTool = screen.startsWith("tools/") ? screen.slice("tools/".length) : undefined;
  const navKey = provider ? "connections" : cliTool ? "tools" : screen;
  const active = SCREENS[navKey]!;
  const Active = active.component;

  return (
    <ToastContext.Provider value={notify}>
      <div className="app-shell">
        <a className="skip-link" href="#main-content">Skip to content</a>
        <div className={`sidebar-overlay ${sidebarOpen ? "is-open" : ""}`} onClick={() => setSidebarOpen(false)} aria-hidden="true" />
        <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="Primary navigation">
          <div className="traffic-lights" aria-hidden="true"><span className="traffic-red" /><span className="traffic-yellow" /><span className="traffic-green" /></div>
          <a className="brand" href="#/gateway" onClick={() => setSidebarOpen(false)}>
            <span className="brand-mark"><Icon>hub</Icon></span>
            <span><strong>Fast 9Router</strong><small>v0.1.0</small></span>
          </a>
          <nav className="sidebar-nav">
            {Object.entries(SCREENS).map(([key, item]) => (
              <a key={key} href={`#/${key}`} aria-current={key === screen ? "page" : undefined}>
                <Icon>{item.icon}</Icon><span>{item.nav}</span>
              </a>
            ))}
            <a className="sidebar-logout" href="/login" onClick={(event) => { event.preventDefault(); void send("/api/auth/logout", "POST").then(() => { setAuthenticated(false); history.replaceState(null, "", "/login"); }); }} aria-label="Sign out">
              <Icon>logout</Icon><span>Sign Out</span>
            </a>
          </nav>
          <div className="sidebar-foot"><span className="status-dot" data-state={serverHealthy === null ? "checking" : serverHealthy ? "healthy" : "error"} /><span>{serverHealthy === null ? "Checking server" : serverHealthy ? "Server online" : "Server unavailable"}</span></div>
        </aside>

        <div className="main-shell">
          <header className="page-header">
            <button type="button" className="menu-button" onClick={() => setSidebarOpen(true)} aria-expanded={sidebarOpen} aria-label="Open menu"><Icon>menu</Icon><span>Menu</span></button>
            <div className="page-heading">
              <span className="page-icon"><Icon>{active.icon}</Icon></span>
              <div><h1>{active.title}</h1><p>{active.description}</p></div>
            </div>
            <div className="header-actions">
              <ThemeToggle />
              <Badge variant={serverHealthy ? "success" : serverHealthy === false ? "error" : "default"} dot>{serverHealthy ? "Online" : serverHealthy === false ? "Offline" : "Checking"}</Badge>
            </div>
          </header>
          <main id="main-content" className="main-content" tabIndex={-1}>{provider ? <ConnectionsScreen provider={provider} /> : cliTool ? <CliToolDetailScreen toolId={cliTool} /> : <Active />}</main>
        </div>
        <ToastStack items={toasts} dismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
      </div>
    </ToastContext.Provider>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn().then((value) => alive && setData(value)).catch((reason: Error) => alive && setError(reason.message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, refresh };
}

export function Notice({ kind, children, icon }: { kind: "error" | "empty" | "loading" | "warning"; children: ReactNode; icon?: string }) {
  if (children === null || children === undefined || children === "") return null;
  return <div className={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}><Icon>{icon || (kind === "error" ? "error" : kind === "warning" ? "warning" : kind === "empty" ? "inbox" : "progress_activity")}</Icon><span>{children}</span></div>;
}
