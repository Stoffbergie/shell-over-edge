import type { Context, Hono } from "hono";
import { maxCommandBytes, maxResultBytes, sessionTtlMs } from "./config";
import { BadRequestError, cleanString, normalizeTimeout, publicBaseUrl, readLimitedText, textResponse } from "./http";
import { logInfo } from "./log";
import { powerShellAgentScript } from "./powershell-scripts";
import { shellAgentScript } from "./shell-scripts";
import {
  appendEvent,
  cleanupExpiredSessions,
  commandKey,
  commandResponse,
  enqueueCommand,
  expireIfNeeded,
  getJson,
  metaKey,
  nextQueuedCommand,
  putJson
} from "./session-store";
import type { CommandRecord, Env, SessionMeta } from "./types";

type SessionApp = Hono<{ Bindings: Env }>;
type SessionContext = Context<{ Bindings: Env }>;
type SessionGuard = { meta: SessionMeta } | { response: Response };
type ScriptKind = "shell" | "powershell";

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maxSendWaitMs = 55_000;

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
  c.executionCtx.waitUntil(cleanupExpiredSessions(c.env).catch((error) => {
    logInfo("cleanup_failed", { error: error instanceof Error ? error.message : String(error) });
  }));

  const now = Date.now();
  const id = crypto.randomUUID().toLowerCase();
  const meta: SessionMeta = {
    id,
    code: id,
    helperName: "terminal",
    status: "waiting",
    createdAt: now,
    expiresAt: now + sessionTtlMs
  };
  await putJson(c.env, metaKey(id), meta);
  await appendEvent(c.env, id, {
    type: "session_created",
    message: `Session ${id} created`,
    status: meta.status
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
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  const input = await readCommandInput(c.req.raw);
  if (!input.body) return textResponse("Command body is required\n", 400);

  const command = await enqueueCommand(c.env, guard.meta.id, {
    type: "shell",
    body: input.body,
    cwd: input.cwd,
    timeoutSeconds: input.timeoutSeconds
  });
  await appendEvent(c.env, guard.meta.id, {
    type: "command_queued",
    message: `Queued command ${command.id}`,
    commandId: command.id
  });
  logInfo("command_queued", { sessionId: guard.meta.id, commandId: command.id, commandType: command.type });

  const result = await waitForCommandResult(c.env, guard.meta.id, command.id, input.timeoutSeconds);
  if (!result) {
    return textResponse("Timed out waiting for command result\n", 504);
  }

  return new Response(result.output || "", {
    status: result.exitCode === 0 ? 200 : 500,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Command-Id": result.id,
      "X-Exit-Code": String(result.exitCode ?? 0)
    }
  });
}

async function agentHello(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  const cwd = cleanString(await readLimitedText(c.req.raw, 2000), 500);
  const meta = { ...guard.meta, status: "connected" as const };
  await putJson(c.env, metaKey(meta.id), meta);
  await putJson(c.env, `sessions/${meta.id}/agent-state.json`, {
    platform: cleanString(c.req.header("x-agent-platform"), 120),
    user: cleanString(c.req.header("x-agent-user"), 120),
    cwd,
    seenAt: Date.now()
  });
  await appendEvent(c.env, meta.id, {
    type: "agent_connected",
    message: "Agent connected",
    status: meta.status
  });
  logInfo("agent_connected", { sessionId: meta.id, platform: cleanString(c.req.header("x-agent-platform"), 120) });
  return textResponse("connected\n");
}

async function agentNext(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  const command = await nextQueuedCommand(c.env, guard.meta.id);
  if (!command) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

  const running = { ...command, status: "running" as const, startedAt: Date.now() };
  await putJson(c.env, commandKey(guard.meta.id, command.id), running);
  await appendEvent(c.env, guard.meta.id, {
    type: "command_started",
    message: `Started command ${command.id}`,
    commandId: command.id
  });
  logInfo("command_started", { sessionId: guard.meta.id, commandId: command.id, commandType: command.type });
  return commandResponse(running);
}

async function agentResult(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  const commandId = cleanString(c.req.param("commandId"), 200);
  const command = await getJson<CommandRecord>(c.env, commandKey(guard.meta.id, commandId));
  if (!command) return textResponse("Command not found\n", 404);

  const exitCode = parseExitCode(new URL(c.req.url).searchParams.get("exit"));
  const output = await readLimitedText(c.req.raw, maxResultBytes);
  const status = exitCode === 0 ? "completed" : "failed";
  const done = { ...command, status, completedAt: Date.now(), exitCode, output } satisfies CommandRecord;
  await putJson(c.env, commandKey(guard.meta.id, command.id), done);
  await appendEvent(c.env, guard.meta.id, {
    type: status === "completed" ? "command_result" : "command_failed",
    message: `Command ${command.id} exited ${exitCode}`,
    commandId: command.id,
    exitCode,
    output
  });
  logInfo("command_result", { sessionId: guard.meta.id, commandId: command.id, exitCode, status });
  return textResponse("ok\n");
}

async function endSession(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"), { allowInactive: true });
  if ("response" in guard) return guard.response;

  if (guard.meta.status !== "ended") {
    const now = Date.now();
    const meta = { ...guard.meta, status: "ended" as const, endedAt: now };
    await putJson(c.env, metaKey(meta.id), meta);
    await appendEvent(c.env, meta.id, {
      type: "session_ended",
      message: `Session ${meta.id} ended`,
      status: meta.status
    });
    logInfo("session_ended", { sessionId: meta.id });
  }
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

async function waitForCommandResult(env: Env, sessionId: string, commandId: string, timeoutSeconds: number): Promise<CommandRecord | null> {
  const deadline = Date.now() + Math.min(timeoutSeconds * 1000 + 1000, maxSendWaitMs);
  while (Date.now() < deadline) {
    const command = await getJson<CommandRecord>(env, commandKey(sessionId, commandId));
    if (command?.status === "completed" || command?.status === "failed") return command;
    await sleep(200);
  }
  return null;
}

function safeSessionId(id: string | undefined): string {
  const value = cleanString(id, 80).toLowerCase();
  return sessionIdPattern.test(value) ? value : "";
}

function parseExitCode(value: string | null): number {
  const parsed = Number(value || "0");
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
