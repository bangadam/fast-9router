// Internal normalized representation — the translation-layer contract.
// Kept deliberately small and stable: the routing workstream imports these
// types plus the normalizer/denormalizer/stream-transform functions from
// "../translate/index.ts".

export type ClientFormat = "openai" | "openai-responses" | "claude";
// "openai" = Chat Completions wire format.

export type Role = "user" | "assistant" | "system" | "developer" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  /** Data URI, http(s) URL, or provider file reference — never fetched here. */
  image_url: string;
  detail?: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  /** JSON-serialized arguments string. */
  arguments: string;
}

export interface ToolResultPart {
  type: "tool_result";
  tool_call_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart;

export interface NormalizedMessage {
  role: Role;
  content: string | ContentPart[];
  /** Assistant-turn reasoning summary text (multi-turn continuity). */
  reasoning_content?: string;
  /** Provider reasoning continuity blob (store=false backends). */
  encrypted_content?: string;
  /** Anthropic cache_control marker — passed through untouched. */
  cache_control?: unknown;
}

export interface NormalizedTool {
  name: string;
  description?: string;
  /** JSON-schema parameters object (input_schema for Claude). */
  parameters?: Record<string, unknown>;
  /** Responses freeform ("custom") tool — response side unwraps input. */
  custom?: boolean;
  /** Untouched fields for non-function/hosted tool types. */
  passthrough?: Record<string, unknown>;
}

export interface ReasoningIntent {
  effort?: string;
  budget_tokens?: number;
}

export interface NormalizedRequest {
  model: string;
  stream: boolean;
  system?: string;
  messages: NormalizedMessage[];
  tools?: NormalizedTool[];
  tool_choice?: unknown;
  reasoning?: ReasoningIntent;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  /** Format-specific fields (stop, service_tier, response_format, …). */
  passthrough?: Record<string, unknown>;
}

export interface UsageCounts {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens?: number;
}

export interface TranslateOptions {
  model?: string;
  /** Names of freeform custom tools — response side unwraps their input. */
  customToolNames?: Set<string>;
}
