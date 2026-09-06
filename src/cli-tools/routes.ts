// /api/admin/cli-tools Hono routes: per-tool GET/POST/PATCH/DELETE plus
// all-statuses aggregate. Inherits the admin app's loopback + same-origin
// guards. Guide-only tools (cursor, roo, continue, amp, qwen, opendesign)
// have no server routes, matching legacy.

import { Hono } from "hono";

import { STATUS_TOOL_IDS, TOOL_HANDLERS, isApplyError } from "./registry.ts";
import type { ToolDeps } from "./core.ts";

const VALID_TOOL = new Set(Object.keys(TOOL_HANDLERS));

function jsonError(status: number, message: string, type: string): Response {
  return Response.json({ error: { message, type } }, { status });
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json() as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createCliToolsApp(deps: ToolDeps = {}): Hono {
  const app = new Hono();

  app.get("/all-statuses", async (c) => {
    const entries = await Promise.all(STATUS_TOOL_IDS.map(async (id) => {
      try {
        const value = await TOOL_HANDLERS[id]!.get(deps);
        return [id, value] as const;
      } catch {
        return [id, null] as const;
      }
    }));
    return Response.json(Object.fromEntries(entries));
  });

  app.get("/:tool-settings", async (c) => {
    const tool = c.req.param("tool-settings").replace(/-settings$/, "");
    if (!VALID_TOOL.has(tool)) return jsonError(404, "tool not found", "not_found");
    try {
      return Response.json(await TOOL_HANDLERS[tool]!.get(deps));
    } catch {
      return jsonError(500, `failed to check ${tool} settings`, "server_error");
    }
  });

  app.post("/:tool-settings", async (c) => {
    const tool = c.req.param("tool-settings").replace(/-settings$/, "");
    const handler = TOOL_HANDLERS[tool];
    if (!handler || !handler.apply) return jsonError(404, "tool not found", "not_found");
    const body = await readJsonBody(c);
    if (body === null) return jsonError(400, "request body must be a JSON object", "invalid_request_error");
    try {
      const result = await handler.apply(body, deps);
      if (isApplyError(result)) return jsonError(400, result.error, "invalid_request_error");
      return Response.json(result);
    } catch {
      return jsonError(500, `failed to apply ${tool} settings`, "server_error");
    }
  });

  app.patch("/:tool-settings", async (c) => {
    const tool = c.req.param("tool-settings").replace(/-settings$/, "");
    const handler = TOOL_HANDLERS[tool];
    if (!handler || !handler.patch) return jsonError(404, "tool not found", "not_found");
    const body = await readJsonBody(c);
    if (body === null) return jsonError(400, "request body must be a JSON object", "invalid_request_error");
    try {
      const result = await handler.patch(body, deps);
      if (isApplyError(result)) return jsonError(400, result.error, "invalid_request_error");
      return Response.json(result);
    } catch {
      return jsonError(500, `failed to patch ${tool} settings`, "server_error");
    }
  });

  app.delete("/:tool-settings", async (c) => {
    const tool = c.req.param("tool-settings").replace(/-settings$/, "");
    const handler = TOOL_HANDLERS[tool];
    if (!handler || !handler.reset) return jsonError(404, "tool not found", "not_found");
    if (handler.resetModel) {
      const model = c.req.query("model") ?? null;
      try {
        const result = await handler.resetModel(model, deps);
        if (isApplyError(result)) return jsonError(400, result.error, "invalid_request_error");
        return Response.json(result);
      } catch {
        return jsonError(500, `failed to reset ${tool} settings`, "server_error");
      }
    }
    try {
      const result = await handler.reset(deps);
      if (isApplyError(result)) return jsonError(400, result.error, "invalid_request_error");
      return Response.json(result);
    } catch {
      return jsonError(500, `failed to reset ${tool} settings`, "server_error");
    }
  });

  return app;
}
