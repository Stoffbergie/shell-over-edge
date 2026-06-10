import type { Context, Hono } from "hono";
import { powerShellAgentScript } from "../../agent/powershell";
import { shellAgentScript } from "../../agent/shell";
import type { SessionMeta } from "../../domain/session";
import { defaultCommandTimeoutSeconds, maxCommandBytes, sessionTtlMs } from "../../shared/config";
import { randomSessionCode } from "../../shared/crypto";
import { BadRequestError, cleanString, normalizeTimeout, publicBaseUrl, readLimitedText, textResponse } from "../../shared/http";
import { logInfo } from "../../shared/log";
import type { Env } from "../env";
import { sessionBridge } from "../services/session-bridge";
import {
  codeKey,
  expireIfNeeded,
  getJson,
  metaKey,
  putJson,
  putSessionCode,
  resolveSessionCode
} from "../services/session-store";

type SessionApp = Hono<{ Bindings: Env }>;
type SessionContext = Context<{ Bindings: Env }>;
type SessionGuard = { meta: SessionMeta } | { response: Response };
type ScriptKind = "shell" | "powershell";

const internalSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sessionCodePattern = /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

export function registerSessionRoutes(app: SessionApp): void {
  app.post("/:id/send", sendCommand);
  app.post("/:id/end", endSession);
  app.post("/api/sessions/:id/hello", agentHello);
  app.get("/api/sessions/:id/next", agentNext);
  app.post("/api/sessions/:id/result/:commandId", agentResult);
}

export function scriptKindForHeaders(headers: Headers): ScriptKind {
  const signal = `${headers.get("accept") || ""} ${headers.get("user-agent") || ""}`;
  return /\b(?:powershell|pwsh)\b/i.test(signal) ? "powershell" : "shell";
}

export async function createSessionResponse(c: SessionContext, kind: ScriptKind): Promise<Response> {
  const now = Date.now();
  const id = crypto.randomUUID().toLowerCase();
  const code = await createSessionCode(c.env);
  const meta: SessionMeta = {
    id,
    code,
    status: "waiting",
    createdAt: now,
    expiresAt: now + sessionTtlMs
  };
  await putJson(c.env, metaKey(id), meta);
  await putSessionCode(c.env, code, id);
  logInfo("session_created", { sessionId: id, expiresAt: meta.expiresAt });

  const baseUrl = publicBaseUrl(c.req.raw, c.env);
  const body = kind === "shell" ? shellAgentScript(baseUrl, meta) : powerShellAgentScript(baseUrl, meta);
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": kind === "shell" ? "text/x-shellscript; charset=utf-8" : "text/plain; charset=utf-8",
      "X-Session-Id": code,
      "X-Session-Code": code
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

async function agentHello(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

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
  const sessionId = await resolveSessionId(env, id);
  if (!sessionId) return { response: textResponse("Session not found\n", 404) };

  const meta = await getJson<SessionMeta>(env, metaKey(sessionId));
  if (!meta) return { response: textResponse("Session not found\n", 404) };

  const fresh = await expireIfNeeded(env, meta);
  if (!options.allowInactive && fresh.status === "ended") return { response: textResponse("Session ended\n", 410) };
  if (!options.allowInactive && fresh.status === "expired") return { response: textResponse("Session expired\n", 410) };
  return { meta: fresh };
}

async function createSessionCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomSessionCode();
    if (!await getJson<{ id: string }>(env, codeKey(code))) return code;
  }
  throw new Error("Could not allocate session code");
}

async function resolveSessionId(env: Env, id: string | undefined): Promise<string> {
  const value = cleanString(id, 80).toLowerCase();
  if (!sessionCodePattern.test(value)) return "";
  const sessionId = await resolveSessionCode(env, value);
  return internalSessionIdPattern.test(sessionId) ? sessionId : "";
}

async function readCommandInput(request: Request): Promise<{ body: string; cwd: string; timeout: number }> {
  const url = new URL(request.url);
  const raw = (await readLimitedText(request, maxCommandBytes)).trim();
  const timeout = normalizeTimeout(url.searchParams.get("timeout") || defaultCommandTimeoutSeconds);
  if (!raw.startsWith("{")) {
    return { body: raw, cwd: "", timeout };
  }

  type CommandPayload = { body?: unknown; cwd?: unknown; timeout?: unknown; timeoutSeconds?: unknown };
  let payload: CommandPayload;
  try {
    payload = JSON.parse(raw) as CommandPayload;
  } catch {
    throw new BadRequestError("Invalid JSON command payload");
  }
  if (payload.timeout !== undefined || payload.timeoutSeconds !== undefined) {
    throw new BadRequestError("Use ?timeout= for command timeout");
  }

  return {
    body: cleanString(payload.body, maxCommandBytes).trim(),
    cwd: cleanString(payload.cwd, 500),
    timeout
  };
}
