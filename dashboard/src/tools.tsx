// CLI Tools screen: grid of tool cards with install/config status, plus a
// per-tool detail page with endpoint/key/model rows, Apply/Reset, and manual
// config display. Ported from 9router's CLI Tools dashboard pages.

import { useEffect, useMemo, useState } from "react";
import { get, send, ApiError } from "./api.ts";
import { Notice, useAsync, useToast } from "./app.tsx";
import { Badge, Button, Card, Icon, Input, Modal, ProviderIcon, Skeleton } from "./primitives.tsx";

// ---------------------------------------------------------------------------
// Registry (order matches 9router CLI_TOOLS)
// ---------------------------------------------------------------------------

type GuideStep = { title: string; desc?: string; value?: string; copyable?: boolean; apiKey?: boolean; model?: boolean; docsUrl?: string };

type ToolMeta = {
  id: string;
  name: string;
  description: string;
  image: string;
  guideOnly?: boolean;
  notes?: string[];
  guideSteps?: GuideStep[];
  codeBlock?: { language: string; code: string };
  installUrl?: string;
};

export const CLI_TOOLS: ToolMeta[] = [
  { id: "claude", name: "[CC]", description: "Anthropic [CC] CLI", image: "claude" },
  { id: "openclaw", name: "Open Claw", description: "Open Claw AI Assistant", image: "openclaw" },
  { id: "codex", name: "[OC] CLI / App", description: "[OC] CLI", image: "codex" },
  { id: "opencode", name: "OpenCode", description: "OpenCode AI Terminal Assistant", image: "opencode" },
  { id: "cowork", name: "Claude Cowork", description: "Claude Desktop Cowork (third-party inference)", image: "claude" },
  { id: "hermes", name: "Hermes Agent", description: "Nous Research self-improving AI agent", image: "hermes" },
  { id: "droid", name: "Factory Droid", description: "Factory Droid AI Assistant", image: "droid" },
  {
    id: "cursor", name: "Cursor", description: "Cursor AI Code Editor", image: "cursor", guideOnly: true,
    notes: ["Requires Cursor Pro account to use this feature.", "Cursor routes requests through its own server, so local endpoint is not supported. Please enable Tunnel or Cloud Endpoint in Settings."],
    guideSteps: [
      { title: "Open Settings", desc: "Go to Settings → Models" },
      { title: "Enable [OI] API", desc: 'Enable "[OI] API key" option' },
      { title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { title: "API Key", apiKey: true },
      { title: "Add Custom Model", desc: 'Click "View All Model" → "Add Custom Model"' },
      { title: "Select Model", model: true },
    ],
  },
  { id: "cline", name: "Cline", description: "Cline AI Coding Assistant", image: "cline" },
  { id: "kilo", name: "Kilo Code", description: "Kilo Code AI Assistant", image: "kilocode" },
  {
    id: "roo", name: "Roo", description: "Roo AI Assistant", image: "roo", guideOnly: true,
    guideSteps: [
      { title: "Open Settings", desc: "Go to Roo Settings panel" },
      { title: "Select Provider", desc: "Choose API Provider → Ollama" },
      { title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { title: "API Key", apiKey: true },
      { title: "Select Model", model: true },
    ],
  },
  {
    id: "continue", name: "Continue", description: "Continue AI Assistant", image: "continue", guideOnly: true,
    guideSteps: [
      { title: "Open Config", desc: "Open Continue configuration file" },
      { title: "API Key", apiKey: true },
      { title: "Select Model", model: true },
      { title: "Add Model Config", desc: "Add the following configuration to your models array:" },
    ],
    codeBlock: {
      language: "json",
      code: `{
  "apiBase": "{{baseUrl}}",
  "title": "{{model}}",
  "model": "{{model}}",
  "provider": "openai",
  "apiKey": "{{apiKey}}"
}`,
    },
  },
  {
    id: "amp", name: "Amp CLI", description: "Sourcegraph Amp coding assistant CLI", image: "amp", guideOnly: true,
    notes: ["Use model aliases to keep Amp shorthand mappings stable across provider updates.", "Suggested shorthand examples: g25p → gemini/gemini-2.5-pro, g25f → gemini/gemini-2.5-flash, cs45 → cc/"],
    guideSteps: [
      { title: "Install Amp", desc: "Install the Amp CLI using the package manager supported by your environment." },
      { title: "API Key", apiKey: true },
      { title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { title: "Select Model", model: true },
      { title: "Add Shorthands", desc: "Map Amp shorthand names such as g25p or cs45 to gateway aliases in your local config." },
    ],
    codeBlock: {
      language: "bash",
      code: `export OPENAI_API_KEY="{{apiKey}}"
export OPENAI_BASE_URL="{{baseUrl}}"
amp --model "{{model}}"
# Example shorthand aliases you can map locally:
# g25p -> gemini/gemini-2.5-pro
# cs45 -> cc/`,
    },
  },
  {
    id: "qwen", name: "Qwen Code", description: "Alibaba Qwen Code CLI, supports [OI], Anthropic & Gemini providers", image: "qwen", guideOnly: true,
    notes: [
      "Qwen Code supports multiple provider types (openai, anthropic, gemini) via modelProviders in settings.json. The gateway works as an [OI]-compatible endpoint.",
      "Any model available in the gateway can be used, not just Qwen models.",
      "Config path: Linux/macOS ~/.qwen/settings.json • Windows %USERPROFILE%\\.qwen\\settings.json",
    ],
    guideSteps: [
      { title: "Install Qwen Code", desc: "npm install -g @qwen-code/qwen-code" },
      { title: "API Key", apiKey: true },
      { title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { title: "Select Model", model: true },
      { title: "Save Config", desc: "Copy the JSON below to your ~/.qwen/settings.json file." },
    ],
    codeBlock: {
      language: "json",
      code: `{
  "security": {
    "auth": {
      "selectedType": "openai",
      "apiKey": "{{apiKey}}",
      "baseUrl": "{{baseUrl}}"
    }
  },
  "model": {
    "name": "{{model}}"
  }
}`,
    },
  },
  { id: "deepseek-tui", name: "DeepSeek TUI", description: "DeepSeek Terminal Coding Agent (Rust TUI)", image: "deepseek-tui" },
  { id: "jcode", name: "jcode", description: "High-performance Rust-based coding agent harness", image: "jcode" },
  { id: "grok-build", name: "Grok Build", description: "xAI Grok Build TUI coding agent", image: "grok-cli" },
  {
    id: "devin", name: "Devin CLI", description: "Cognition Devin CLI, local binary called by the Devin CLI provider via ACP/stdio", image: "devin-cli", guideOnly: true,
    installUrl: "https://cli.devin.ai",
    notes: [
      "This is a local dependency, not a routed CLI. The Devin CLI provider spawns `devin acp --agent-type summarizer` and relays its output.",
      "Install the Devin CLI and run `devin auth login`; without it, the provider returns a spawn error on first request.",
    ],
    guideSteps: [
      { title: "Install Devin CLI", desc: "Install via the official installer at cli.devin.ai.", docsUrl: "https://cli.devin.ai" },
      { title: "Authenticate", desc: "Log in once so the binary stores its own credentials." },
      { title: "Use the provider", desc: "Pick any Devin CLI model under the Providers tab. No API key field needed." },
    ],
    codeBlock: { language: "bash", code: `# Install Devin CLI (see https://cli.devin.ai for options)\ndevin auth login\n\n# Verify detection (optional)\ndevin --version` },
  },
  {
    id: "opendesign", name: "OpenDesign", description: "OpenDesign, open-sourced. Agent-native design skills pack", image: "opendesign", guideOnly: true,
    notes: [
      "OpenDesign ships as a plugin/skills pack installed into [CC], Cursor, [OC], Gemini CLI, or OpenCode. It inherits the host agent's model config: once your host points at the gateway, /opendesign sessions route through it automatically.",
      "Invoke with /opendesign <brief>.",
    ],
    guideSteps: [
      { title: "Install the plugin", desc: "Pick your host below and run the matching install command from the matrix." },
      { title: "No config needed", desc: "OpenDesign runs inside your host agent and uses its model config." },
      { title: "Start designing", desc: "Invoke OpenDesign from your agent:", value: "/opendesign make a pitch deck for a seed-stage AI company, 10 slides", copyable: true },
    ],
    codeBlock: {
      language: "bash",
      code: `# [CC]
/plugin marketplace add manalkaff/opendesign
/plugin install opendesign@opendesign

# Cursor
/add-plugin opendesign

# [OC] CLI
/plugins   # search "opendesign" -> Install Plugin

# [OC] App
# Plugins sidebar -> OpenDesign (Design section) -> +

# Gemini CLI
gemini extensions install https://github.com/manalkaff/opendesign

# OpenCode
# Fetch and follow .opencode/INSTALL.md from the repo`,
    },
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolStatus = {
  installed?: boolean;
  has9Router?: boolean;
  message?: string;
  settings?: Record<string, unknown> | null;
  config?: unknown;
  configPath?: string;
  settingsPath?: string;
  authPath?: string;
  version?: string | null;
  source?: string | null;
  installUrl?: string;
  opencode?: { models: string[]; activeModel: string | null; baseURL: string | null };
};

type StatusMap = Record<string, ToolStatus | null>;

type GatewayInfo = { enforce: boolean; keys: Array<{ isActive: boolean }> };

function statusOf(status: ToolStatus | null | undefined): { label: string; variant: "default" | "success" | "warning" } {
  if (!status) return { label: "Unknown", variant: "default" };
  if (status.installed === false) return { label: "Not installed", variant: "default" };
  if (status.has9Router) return { label: "Connected", variant: "success" };
  return { label: "Not configured", variant: "warning" };
}

function message(reason: unknown): string {
  return reason instanceof ApiError ? reason.message : String(reason);
}

const BASE_URL_DEFAULT = `${location.protocol}//${location.host}`;

// ---------------------------------------------------------------------------
// List screen
// ---------------------------------------------------------------------------

export function CliToolsScreen() {
  const { data, error, loading } = useAsync<StatusMap>(() => get("/api/admin/cli-tools/all-statuses"), []);

  return <section>
    {loading && <div className="provider-grid">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} rows={2} />)}</div>}
    {error && <Notice kind="error">Failed to load CLI tool statuses: {message(error)}</Notice>}
    {!loading && !error && (
      <div className="provider-grid">
        {CLI_TOOLS.map((tool) => {
          const status = data?.[tool.id] ?? null;
          const pill = statusOf(status);
          return (
            <a className="card provider-card provider-link cli-tool-card" href={`#/tools/${tool.id}`} key={tool.id}>
              <div className="provider-card-head">
                <ToolIcon image={tool.image} name={tool.name} />
                <div><h3>{tool.name}</h3><p>{tool.description}</p></div>
                <Icon>chevron_right</Icon>
                <div className="provider-status"><Badge variant={pill.variant} dot>{pill.label}</Badge></div>
              </div>
            </a>
          );
        })}
      </div>
    )}
  </section>;
}

function ToolIcon({ image, name, size = 42 }: { image: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ProviderIcon provider="openai" alt={name} size={size} />;
  return (
    <span className="provider-icon" style={{ width: size, height: size }}>
      <img src={`/providers/${image}.png`} alt={`${name} logo`} onError={() => setFailed(true)} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Detail screen
// ---------------------------------------------------------------------------

type ModelOption = { id: string; name: string };

export function CliToolDetailScreen({ toolId }: { toolId: string }) {
  const tool = CLI_TOOLS.find((t) => t.id === toolId);
  const statusState = useAsync<ToolStatus>(() => get(`/api/admin/cli-tools/${toolId}-settings`), [toolId]);
  const modelsState = useAsync<{ data: Array<{ id: string }> }>(() => get("/api/admin/models"), [toolId]);
  const gatewayState = useAsync<GatewayInfo>(() => get("/api/admin/gateway"), [toolId]);
  const notify = useToast();

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [subagentModel, setSubagentModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelPicker, setModelPicker] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const status = statusState.data;
  const modelOptions = useMemo(() => (modelsState.data?.data ?? []).map((m) => ({ id: m.id, name: m.id })), [modelsState.data]);
  const baseUrlValue = baseUrl || BASE_URL_DEFAULT;

  // Hydrate form from status once loaded.
  useEffect(() => {
    if (!status) return;
    const env = (status.settings as { env?: Record<string, string> } | null)?.env;
    if (env?.ANTHROPIC_BASE_URL) setBaseUrl(env.ANTHROPIC_BASE_URL.replace(/\/v1$/, ""));
    else if (status.opencode?.baseURL) setBaseUrl(status.opencode.baseURL.replace(/\/v1$/, ""));
    if (env?.ANTHROPIC_AUTH_TOKEN) setApiKey(env.ANTHROPIC_AUTH_TOKEN);
    if (status.opencode) {
      setModels(status.opencode.models);
      if (status.opencode.activeModel) setModel(status.opencode.activeModel);
    }
  }, [status]);

  if (!tool) return <Notice kind="empty">Unknown CLI tool.</Notice>;

  const pill = statusOf(status);
  const isConfigurable = !tool.guideOnly && status?.installed !== false;

  const apply = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { baseUrl: baseUrlValue, apiKey, model, models };
      if (subagentModel) body.subagentModel = subagentModel;
      if (tool.id === "claude") {
        body.env = {
          ANTHROPIC_BASE_URL: baseUrlValue,
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ...(model ? { ANTHROPIC_MODEL: model } : {}),
        };
      }
      const result = await send<{ message: string }>(`/api/admin/cli-tools/${tool.id}-settings`, "POST", body);
      notify(result.message, "success");
      statusState.refresh();
    } catch (reason) {
      notify(message(reason), "error");
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      const result = await send<{ message: string }>(`/api/admin/cli-tools/${tool.id}-settings`, "DELETE");
      notify(result.message, "success");
      setModel(""); setModels([]); setSubagentModel("");
      statusState.refresh();
    } catch (reason) {
      notify(message(reason), "error");
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => notify("Copied to clipboard", "success"), () => notify("Copy failed", "error"));
  };

  return <section className="cli-tool-detail">
    <a className="back-link" href="#/tools"><Icon>arrow_back</Icon>Back to CLI Tools</a>
    <Card className="cli-tool-panel">
      <div className="provider-card-head cli-tool-head">
        <ToolIcon image={tool.image} name={tool.name} size={44} />
        <div><h3>{tool.name}</h3><p>{tool.description}</p></div>
        {status && <Badge variant={pill.variant} dot>{pill.label}</Badge>}
        {status?.version && <span className="cli-tool-version">{status.version}</span>}
      </div>

      {statusState.loading && <div className="cli-tool-body"><Skeleton rows={3} /></div>}
      {statusState.error && <div className="cli-tool-body"><Notice kind="error">Failed to load settings: {message(statusState.error)}</Notice></div>}

      {status && tool.guideOnly && (
        <div className="cli-tool-body">
          {tool.notes?.map((note) => <Notice kind="warning">{note}</Notice>)}
          <ol className="cli-guide-steps">
            {tool.guideSteps?.map((step, index) => (
              <li key={index}>
                <strong>{step.title}</strong>
                {step.desc && <p>{step.desc}</p>}
                {step.value && (
                  <div className="cli-guide-value">
                    <code>{step.value.replace("{{baseUrl}}", `${baseUrlValue}/v1`)}</code>
                    {step.copyable && <Button size="sm" variant="ghost" icon="content_copy" onClick={() => copy(step.value!.replace("{{baseUrl}}", `${baseUrlValue}/v1`))}>Copy</Button>}
                  </div>
                )}
                {step.apiKey && (
                  <div className="cli-guide-value">
                    <code>{gatewayState.data && gatewayState.data.keys.some((key) => key.isActive) ? "Use your gateway API key (Endpoint & Key page)" : "No gateway key configured. Create one first"}</code>
                  </div>
                )}
                {step.model && <p className="cli-guide-hint">Pick any model from the Providers page model list.</p>}
              </li>
            ))}
          </ol>
          {tool.codeBlock && (
            <div className="cli-guide-code">
              <div className="cli-guide-code-head">
                <span>{tool.codeBlock.language}</span>
                <Button size="sm" variant="ghost" icon="content_copy" onClick={() => copy(tool.codeBlock!.code
                  .replace(/\{\{baseUrl\}\}/g, `${baseUrlValue}/v1`)
                  .replace(/\{\{apiKey\}\}/g, gatewayState.data && gatewayState.data.keys.some((key) => key.isActive) ? "YOUR_GATEWAY_KEY" : "sk_9router")
                  .replace(/\{\{model\}\}/g, model || "surplus/glm-5.3"))}>Copy</Button>
              </div>
              <pre><code>{tool.codeBlock.code
                .replace(/\{\{baseUrl\}\}/g, `${baseUrlValue}/v1`)
                .replace(/\{\{apiKey\}\}/g, gatewayState.data && gatewayState.data.keys.some((key) => key.isActive) ? "YOUR_GATEWAY_KEY" : "sk_9router")
                .replace(/\{\{model\}\}/g, model || "surplus/glm-5.3")}</code></pre>
            </div>
          )}
        </div>
      )}

      {status && !tool.guideOnly && status.installed === false && (
        <div className="cli-tool-body">
          <Notice kind="warning">{status.message ?? `${tool.name} is not installed.`}</Notice>
          {tool.installUrl && <p><a className="learn-link" href={tool.installUrl} target="_blank" rel="noreferrer">Install instructions <Icon>open_in_new</Icon></a></p>}
        </div>
      )}

      {status && isConfigurable && (
        <div className="cli-tool-body">
          <div className="cli-row"><label>Base URL</label>
            <div className="cli-row-control">
              <Input value={baseUrl} placeholder={BASE_URL_DEFAULT} onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <div className="cli-row"><label>Current</label><span className="cli-current">{status.configPath ?? status.settingsPath ?? status.authPath ?? "Not configured"}</span></div>
          <div className="cli-row"><label>API Key</label>
            <div className="cli-row-control">
              <Input type="password" value={apiKey} placeholder="Gateway API key" onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <div className="cli-row"><label>Model</label>
            <div className="cli-row-control">
              <Input value={model} placeholder="e.g. surplus/glm-5.3" onInput={(e) => setModel((e.target as HTMLInputElement).value)} />
              <Button size="sm" variant="ghost" onClick={() => setModelPicker("model")}>Select Model</Button>
            </div>
          </div>
          {(tool.id === "codex" || tool.id === "opencode") && (
            <div className="cli-row"><label>Subagent Model</label>
              <div className="cli-row-control">
                <Input value={subagentModel} placeholder="Inherits main model" onInput={(e) => setSubagentModel((e.target as HTMLInputElement).value)} />
                <Button size="sm" variant="ghost" onClick={() => setModelPicker("subagent")}>Select Model</Button>
              </div>
            </div>
          )}
          <div className="cli-actions">
            <Button icon="save" loading={busy} onClick={apply}>Apply</Button>
            <Button icon="restore" variant="ghost" loading={busy} onClick={reset}>Reset</Button>
            <Button variant="ghost" icon="content_copy" onClick={() => setManualOpen(true)}>Manual Config</Button>
          </div>
        </div>
      )}
    </Card>

    <Modal isOpen={modelPicker !== null} onClose={() => setModelPicker(null)} title="Select Model">
      <div className="cli-model-list">
        {modelOptions.length === 0 && <Notice kind="empty">No models available. Add a provider connection first.</Notice>}
        {modelOptions.map((option) => (
          <button type="button" className="cli-model-option" key={option.id} onClick={() => {
            if (modelPicker === "subagent") setSubagentModel(option.id);
            else setModel(option.id);
            setModelPicker(null);
          }}>{option.name}</button>
        ))}
      </div>
    </Modal>

    <Modal isOpen={manualOpen} onClose={() => setManualOpen(false)} title="Manual Config">
      <p className="cli-manual-path">{status?.configPath ?? status?.settingsPath ?? "Managed automatically by the gateway"}</p>
      <pre className="cli-manual-config"><code>{JSON.stringify(status?.settings ?? status?.config ?? {}, null, 2)}</code></pre>
    </Modal>
  </section>;
}
