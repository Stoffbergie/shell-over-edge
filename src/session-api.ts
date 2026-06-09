import type { Context, Hono } from "hono";
import { maxCommandBytes, sessionTtlMs } from "./config";
import { BadRequestError, cleanString, normalizeTimeout, publicBaseUrl, readLimitedText, textResponse } from "./http";
import { logInfo } from "./log";
import { powerShellAgentScript } from "./powershell-scripts";
import { sessionBridge } from "./session-bridge";
import { shellAgentScript } from "./shell-scripts";
import {
  metaKey,
  putJson
} from "./session-store";
import type { Env, SessionMeta } from "./types";

type SessionApp = Hono<{ Bindings: Env }>;
type SessionContext = Context<{ Bindings: Env }>;
type ScriptKind = "shell" | "powershell";

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function registerSessionRoutes(app: SessionApp): void {
  app.post("/api/sessions", (c) => createSession(c, "shell"));
  app.post("/api/sessions.ps1", (c) => createSession(c, "powershell"));
  app.post("/api/sessions/:id/send", sendCommand);
  app.post("/api/sessions/:id/hello", agentHello);
  app.get("/api/sessions/:id/next", agentNext);
  app.post("/api/sessions/:id/result/:commandId", agentResult);
  app.post("/api/sessions/:id/end", endSession);
}

async function createSession(c: SessionContext, kind: ScriptKind): Promise<Response> {
  const now = Date.now();
  const id = crypto.randomUUID().toLowerCase();
  const meta: SessionMeta = {
    id,
    status: "waiting",
    createdAt: now,
    expiresAt: now + sessionTtlMs
  };
  await putJson(c.env, metaKey(id), meta);
  await sessionBridge(c.env, id).fetch("https://session/open", {
    method: "POST",
    body: JSON.stringify({ expiresAt: meta.expiresAt })
  });
  logInfo("session_created", { sessionId: id, expiresAt: meta.expiresAt });

  const baseUrl = publicBaseUrl(c.req.raw, c.env);
  const body = kind === "shell" ? shellAgentScript(baseUrl, meta) : powerShellAgentScript(baseUrl, meta);
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": kind === "shell" ? "text/x-shellscript; charset=utf-8" : "text/plain; charset=utf-8",
      "X-Session-Id": id
    }
  });
}

async function sendCommand(c: SessionContext): Promise<Response> {
  const sessionId = safeSessionId(c.req.param("id"));
  if (!sessionId) return textResponse("Session not found\n", 404);

  const input = await readCommandInput(c.req.raw);
  if (!input.body) return textResponse("Command body is required\n", 400);

  return sessionBridge(c.env, sessionId).fetch("https://session/send", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

async function agentHello(c: SessionContext): Promise<Response> {
  const sessionId = safeSessionId(c.req.param("id"));
  if (!sessionId) return textResponse("Session not found\n", 404);

  await readLimitedText(c.req.raw, 2000);
  logInfo("agent_connected", { sessionId, platform: cleanString(c.req.header("x-agent-platform"), 120) });
  return sessionBridge(c.env, sessionId).fetch("https://session/hello", { method: "POST" });
}

async function agentNext(c: SessionContext): Promise<Response> {
  const sessionId = safeSessionId(c.req.param("id"));
  if (!sessionId) return textResponse("Session not found\n", 404);

  return sessionBridge(c.env, sessionId).fetch("https://session/next");
}

async function agentResult(c: SessionContext): Promise<Response> {
  const sessionId = safeSessionId(c.req.param("id"));
  if (!sessionId) return textResponse("Session not found\n", 404);

  const commandId = cleanString(c.req.param("commandId"), 200);
  if (!commandId) return textResponse("Command not found\n", 404);
  return sessionBridge(c.env, sessionId).fetch(`https://session/result/${commandId}${new URL(c.req.url).search}`, {
    method: "POST",
    body: c.req.raw.body
  });
}

async function endSession(c: SessionContext): Promise<Response> {
  const sessionId = safeSessionId(c.req.param("id"));
  if (!sessionId) return textResponse("Session not found\n", 404);

  const closed = await sessionBridge(c.env, sessionId).fetch("https://session/end", { method: "POST" });
  if (!closed.ok && closed.status !== 410) return closed;
  const now = Date.now();
  await putJson(c.env, metaKey(sessionId), {
    id: sessionId,
    status: "ended",
    createdAt: now,
    expiresAt: now,
    endedAt: now
  } satisfies SessionMeta);
  logInfo("session_ended", { sessionId });
  return textResponse("ended\n");
}

async function readCommandInput(request: Request): Promise<{ body: string; cwd: string; timeoutSeconds: number }> {
  const url = new URL(request.url);
  const raw = (await readLimitedText(request, maxCommandBytes)).trim();
  const defaultTimeout = normalizeTimeout(url.searchParams.get("timeout") || request.headers.get("x-timeout-seconds") || 30);
  if (!raw.startsWith("{")) {
    return { body: raw, cwd: "", timeoutSeconds: defaultTimeout };
  }

  type CommandPayload = { body?: unknown; cwd?: unknown; timeoutSeconds?: unknown; timeout?: unknown };
  let payload: CommandPayload;
  try {
    payload = JSON.parse(raw) as CommandPayload;
  } catch {
    throw new BadRequestError("Invalid JSON command payload");
  }

  return {
    body: cleanString(payload.body, maxCommandBytes).trim(),
    cwd: cleanString(payload.cwd, 500),
    timeoutSeconds: normalizeTimeout(payload.timeoutSeconds ?? payload.timeout ?? defaultTimeout)
  };
}

function safeSessionId(id: string | undefined): string {
  const value = cleanString(id, 80).toLowerCase();
  return sessionIdPattern.test(value) ? value : "";
}
