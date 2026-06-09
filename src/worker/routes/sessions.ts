import type { Context, Hono } from "hono";
import { powerShellAgentScript } from "../../agent/powershell";
import { shellAgentScript } from "../../agent/shell";
import type { SessionMeta } from "../../domain/session";
import { maxCommandBytes, maxDirectCandidateBytes, sessionTtlMs } from "../../shared/config";
import { BadRequestError, cleanString, normalizeTimeout, publicBaseUrl, readLimitedText, textResponse } from "../../shared/http";
import { logInfo } from "../../shared/log";
import type { Env } from "../env";
import { sessionBridge } from "../services/session-bridge";
import {
  expireIfNeeded,
  getJson,
  metaKey,
  putJson
} from "../services/session-store";

type SessionApp = Hono<{ Bindings: Env }>;
type SessionContext = Context<{ Bindings: Env }>;
type SessionGuard = { meta: SessionMeta } | { response: Response };
type ScriptKind = "shell" | "powershell";

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function registerSessionRoutes(app: SessionApp): void {
  app.post("/api/sessions", (c) => createSession(c, "shell"));
  app.post("/api/sessions.ps1", (c) => createSession(c, "powershell"));
  app.post("/api/sessions/:id/send", sendCommand);
  app.post("/api/sessions/:id/candidates", publishCandidate);
  app.get("/api/sessions/:id/candidates", listCandidates);
  app.post("/api/sessions/:id/direct-attempts", recordDirectAttempt);
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
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  const input = await readCommandInput(c.req.raw);
  if (!input.body) return textResponse("Command body is required\n", 400);

  return sessionBridge(c.env, guard.meta.id).fetch("https://session/send", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

async function publishCandidate(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  const body = await readLimitedText(c.req.raw, maxDirectCandidateBytes);
  return sessionBridge(c.env, guard.meta.id).fetch("https://session/candidates", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body
  });
}

async function listCandidates(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  const url = new URL(c.req.url);
  return sessionBridge(c.env, guard.meta.id).fetch(`https://session/candidates${url.search}`);
}

async function recordDirectAttempt(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  const body = await readLimitedText(c.req.raw, 2000);
  return sessionBridge(c.env, guard.meta.id).fetch("https://session/direct-attempts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body
  });
}

async function agentHello(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  await readLimitedText(c.req.raw, 2000);
  logInfo("agent_connected", { sessionId: guard.meta.id, platform: cleanString(c.req.header("x-agent-platform"), 120) });
  return textResponse("connected\n");
}

async function agentNext(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  return sessionBridge(c.env, guard.meta.id).fetch("https://session/next");
}

async function agentResult(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  const commandId = cleanString(c.req.param("commandId"), 200);
  if (!commandId) return textResponse("Command not found\n", 404);
  return sessionBridge(c.env, guard.meta.id).fetch(`https://session/result/${commandId}${new URL(c.req.url).search}`, {
    method: "POST",
    body: c.req.raw.body
  });
}

async function endSession(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"), { allowInactive: true });
  if ("response" in guard) return guard.response;

  if (guard.meta.status !== "ended") {
    const now = Date.now();
    const meta = { ...guard.meta, status: "ended" as const, endedAt: now };
    await putJson(c.env, metaKey(meta.id), meta);
    logInfo("session_ended", { sessionId: meta.id });
  }
  await sessionBridge(c.env, guard.meta.id).fetch("https://session/end", { method: "POST" });
  return textResponse("ended\n");
}

async function requireSession(env: Env, id: string | undefined, options: { allowInactive?: boolean } = {}): Promise<SessionGuard> {
  const sessionId = safeSessionId(id);
  if (!sessionId) return { response: textResponse("Session not found\n", 404) };

  const meta = await getJson<SessionMeta>(env, metaKey(sessionId));
  if (!meta) return { response: textResponse("Session not found\n", 404) };

  const fresh = await expireIfNeeded(env, meta);
  if (!options.allowInactive && fresh.status === "ended") return { response: textResponse("Session ended\n", 410) };
  if (!options.allowInactive && fresh.status === "expired") return { response: textResponse("Session expired\n", 410) };
  return { meta: fresh };
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
