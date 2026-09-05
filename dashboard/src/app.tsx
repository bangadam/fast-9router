import type { ComponentType, ComponentChildren } from "preact";
import { createContext } from "preact";
import { useCallback, useContext, useEffect, useState } from "preact/hooks";
import { get, type Provider } from "./api.ts";
import { ConnectionsScreen } from "./connections.tsx";
import { GatewayScreen } from "./gateway.tsx";
import { StatusScreen } from "./status.tsx";
import { Badge, Icon, ToastStack, type ToastItem } from "./primitives.tsx";

const ConnectionsOverviewScreen = () => <ConnectionsScreen />;

const SCREENS: Record<string, { nav: string; title: string; description: string; icon: string; component: ComponentType }> = {
  gateway: { nav: "Endpoint & Key", title: "Endpoint", description: "API endpoint and gateway key configuration", icon: "api", component: GatewayScreen },
  connections: { nav: "Providers", title: "Providers", description: "Manage your AI provider connections", icon: "dns", component: ConnectionsOverviewScreen },
  status: { nav: "Usage", title: "Usage & Analytics", description: "Monitor API usage, token consumption, and server health", icon: "bar_chart", component: StatusScreen },
};

type ToastKind = ToastItem["kind"];
const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

function currentHash(): string {
  const hash = location.hash.replace(/^#\/?/, "").split("?", 1)[0]!;
  if (hash in SCREENS) return hash;
  if (/^providers\/(codex|anthropic|openai)$/.test(hash)) return hash;
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
    <button type="button" class="theme-toggle" onClick={() => setTheme(next)} aria-label={`Theme: ${theme}. Switch to ${next}.`} title={`Theme: ${theme}. Switch to ${next}.`}>
      <Icon>{icon}</Icon><span>{theme}</span>
    </button>
  );
}

export function App() {
  const [screen, setScreen] = useState(currentHash);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [serverHealthy, setServerHealthy] = useState<boolean | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

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
    let alive = true;
    get("/api/admin/status").then(() => alive && setServerHealthy(true)).catch(() => alive && setServerHealthy(false));
    return () => { alive = false; };
  }, [screen]);

  const notify = useCallback((message: string, kind: ToastKind = "info") => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, message, kind }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4200);
  }, []);

  const provider = screen.startsWith("providers/") ? screen.slice("providers/".length) as Provider : undefined;
  const active = SCREENS[provider ? "connections" : screen]!;
  const Active = active.component;

  return (
    <ToastContext.Provider value={notify}>
      <div class="app-shell">
        <a class="skip-link" href="#main-content">Skip to content</a>
        <div class={`sidebar-overlay ${sidebarOpen ? "is-open" : ""}`} onClick={() => setSidebarOpen(false)} aria-hidden="true" />
        <aside class={`sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="Primary navigation">
          <div class="traffic-lights" aria-hidden="true"><span class="traffic-red" /><span class="traffic-yellow" /><span class="traffic-green" /></div>
          <a class="brand" href="#/gateway" onClick={() => setSidebarOpen(false)}>
            <span class="brand-mark"><Icon>hub</Icon></span>
            <span><strong>Fast 9Router</strong><small>v0.1.0</small></span>
          </a>
          <nav class="sidebar-nav">
            {Object.entries(SCREENS).map(([key, item]) => (
              <a key={key} href={`#/${key}`} aria-current={key === screen ? "page" : undefined}>
                <Icon>{item.icon}</Icon><span>{item.nav}</span>
              </a>
            ))}
          </nav>
          <div class="sidebar-foot"><span class="status-dot" data-state={serverHealthy === null ? "checking" : serverHealthy ? "healthy" : "error"} /><span>{serverHealthy === null ? "Checking server" : serverHealthy ? "Server online" : "Server unavailable"}</span></div>
        </aside>

        <div class="main-shell">
          <div class="landing-grid" aria-hidden="true" />
          <header class="page-header">
            <button type="button" class="menu-button" onClick={() => setSidebarOpen(true)} aria-expanded={sidebarOpen} aria-label="Open menu"><Icon>menu</Icon><span>Menu</span></button>
            <div class="page-heading">
              <span class="page-icon"><Icon>{active.icon}</Icon></span>
              <div><h1>{active.title}</h1><p>{active.description}</p></div>
            </div>
            <div class="header-actions">
              <ThemeToggle />
              <Badge variant={serverHealthy ? "success" : serverHealthy === false ? "error" : "default"} dot>{serverHealthy ? "Online" : serverHealthy === false ? "Offline" : "Checking"}</Badge>
            </div>
          </header>
          <main id="main-content" class="main-content" tabindex={-1}>{provider ? <ConnectionsScreen provider={provider} /> : <Active />}</main>
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

export function Notice({ kind, children, icon }: { kind: "error" | "empty" | "loading" | "warning"; children: ComponentChildren; icon?: string }) {
  if (children === null || children === undefined || children === "") return null;
  return <div class={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}><Icon>{icon || (kind === "error" ? "error" : kind === "warning" ? "warning" : kind === "empty" ? "inbox" : "progress_activity")}</Icon><span>{children}</span></div>;
}
