// Public entry for the translation layer. The routing workstream imports
// everything from "../translate/index.ts" — keep this surface stable.

export type {
  ClientFormat,
  ContentPart,
  ImagePart,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  ReasoningIntent,
  Role,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  TranslateOptions,
  UsageCounts,
} from "./types.ts";

// Request normalizers (client format → internal)
export { fromOpenaiChatRequest } from "./request/openaiChat.ts";
export { fromResponsesRequest } from "./request/responses.ts";
export { fromClaudeRequest } from "./request/claude.ts";

// Request denormalizers (internal → upstream format)
export { toOpenaiChatRequest } from "./request/openaiChat.ts";
export { toResponsesRequest } from "./request/responses.ts";
export { toClaudeRequest } from "./request/claude.ts";

// Codex upstream normalization (apply after toResponsesRequest for Codex)
export {
  normalizeCodexResponsesRequest,
  normalizeReasoningEffort,
} from "./request/responses.ts";

// Non-streaming response translation + usage extraction
export { extractUsage, translateResponse } from "./response.ts";

// Streaming translation (upstream SSE bytes → client SSE bytes)
export { translateStream } from "./stream.ts";
