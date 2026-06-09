import { Hono } from "hono";
import { powerShellAgentScript, simplePowerShellAgentScript } from "./powershell-scripts";
import { shellAgentScript, simpleShellAgentScript } from "./shell-scripts";
import { terminalUsage } from "./terminal-usage";
import { maxCommandBytes, maxFileBytes, maxResultBytes, sessionTtlMs } from "./config";
import { constantTimeEqual, randomId, randomToken, sha256 } from "./crypto";
import { BadRequestError, PayloadTooLargeError, apiKey, bearerToken, cleanString, jsonResponse, legacyBridgeEnabled, normalizeTimeout, publicBaseUrl, readJson, readLimitedText, requireSimpleCode, textResponse } from "./http";
import { bridgeStub } from "./legacy-bridge";
import { logInfo } from "./log";
import { appendEvent, cleanupExpiredSessions, codeKey, commandKey, commandResponse, createUniqueCode, downloadKey, enqueueCommand, expireIfNeeded, getJson, getSessionByCode, listEvents, metaKey, nextQueuedCommand, putJson } from "./session-store";
import { quotePowerShell, quoteShell, safeFileName } from "./strings";
import type { AgentGuard, CodeIndex, CommandRecord, Env, HelperGuard, SessionMeta } from "./types";

export const app = new Hono<{ Bindings: Env }>();

app.onError((error) => {
  if (error instanceof PayloadTooLargeError) {
    return jsonResponse({ error: error.message }, 413);
  }
  if (error instanceof BadRequestError) {
    return jsonResponse({ error: error.message }, 400);
  }
  return jsonResponse({ error: "Internal server error" }, 500);
});

app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("Cache-Control") === "no-store") return;
  const headers = new Headers(c.res.headers);
  headers.set("Cache-Control", "no-store");
  c.res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers
  });
});

app.post("/", async (c) => {
  if (!legacyBridgeEnabled(c.env)) return jsonResponse({ error: "Legacy bridge disabled" }, 404);
  const code = apiKey(c.req.raw);
  if (!code) return textResponse("Missing or invalid x-api-key UUID", 401);
  const body = (await readLimitedText(c.req.raw, maxCommandBytes)).trim();
  if (!body) return textResponse("Command body is required", 400);
  return bridgeStub(c.env, code).fetch("https://bridge/command", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Timeout-Seconds": String(normalizeTimeout(c.req.header("x-timeout-seconds") || 30))
    },
    body
  });
});

app.get("/", (c) => textResponse(terminalUsage(publicBaseUrl(c.req.raw, c.env))));
app.get("/connect.sh", (c) => legacyBridgeEnabled(c.env) ? textResponse(simpleShellAgentScript(publicBaseUrl(c.req.raw, c.env)), 200, "text/x-shellscript") : textResponse("Not found\n", 404));
app.get("/connect.ps1", (c) => legacyBridgeEnabled(c.env) ? textResponse(simplePowerShellAgentScript(publicBaseUrl(c.req.raw, c.env)), 200, "text/plain; charset=utf-8") : textResponse("Not found\n", 404));

app.get("/api/v1/:code/events", async (c) => {
  if (!legacyBridgeEnabled(c.env)) return jsonResponse({ error: "Not found" }, 404);
  const guard = requireSimpleCode(c.req.raw, c.req.param("code"));
  if ("response" in guard) return guard.response;
  return bridgeStub(c.env, guard.code).fetch("https://bridge/events");
});

app.post("/api/v1/:code/result/:commandId", async (c) => {
  if (!legacyBridgeEnabled(c.env)) return jsonResponse({ error: "Not found" }, 404);
  const guard = requireSimpleCode(c.req.raw, c.req.param("code"));
  if ("response" in guard) return guard.response;
  const commandId = cleanString(c.req.param("commandId"), 200);
  return bridgeStub(c.env, guard.code).fetch(`https://bridge/result/${commandId}${new URL(c.req.url).search}`, {
    method: "POST",
    body: c.req.raw.body
  });
});

app.post("/api/v1/:code/bye", async (c) => {
  if (!legacyBridgeEnabled(c.env)) return jsonResponse({ error: "Not found" }, 404);
  const guard = requireSimpleCode(c.req.raw, c.req.param("code"));
  if ("response" in guard) return guard.response;
  return bridgeStub(c.env, guard.code).fetch("https://bridge/bye", { method: "POST" });
});

app.post("/api/sessions", async (c) => {
  c.executionCtx.waitUntil(cleanupExpiredSessions(c.env).catch((error) => {
    logInfo("cleanup_failed", { error: error instanceof Error ? error.message : String(error) });
  }));
  const payload = await readJson<{ helperName?: string }>(c.req.raw);
  const helperName = cleanString(payload.helperName, 80) || "Dirk";
  const helperToken = randomToken();
  const agentToken = randomToken();
  const now = Date.now();
  const id = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
  const code = await createUniqueCode(c.env);
  const meta: SessionMeta = {
    id,
    code,
    helperName,
    helperTokenHash: await sha256(helperToken),
    agentTokenHash: await sha256(agentToken),
    status: "waiting",
    createdAt: now,
    expiresAt: now + sessionTtlMs
  };
  await putJson(c.env, metaKey(id), meta);
  await putJson(c.env, codeKey(code), { id, code, createdAt: now, expiresAt: meta.expiresAt } satisfies CodeIndex);
  await appendEvent(c.env, id, {
    type: "session_created",
    message: `Session ${code} created for ${helperName}`,
    status: meta.status
  });
  logInfo("session_created", { sessionId: id, expiresAt: meta.expiresAt });
  const baseUrl = publicBaseUrl(c.req.raw, c.env);
  return jsonResponse({
    id,
    code,
    helperName,
    status: meta.status,
    expiresAt: meta.expiresAt,
    helperToken,
    agentToken,
    shellCommand: `curl -fsSL -H ${quoteShell(`Authorization: Bearer ${agentToken}`)} ${quoteShell(`${baseUrl}/start/${code}.sh`)} | sh`,
    windowsCommand: `$headers = @{ Authorization = ${quotePowerShell(`Bearer ${agentToken}`)} }; irm -Headers $headers ${quotePowerShell(`${baseUrl}/start/${code}.ps1`)} | iex`
  });
});

app.get("/api/sessions/:id", async (c) => {
  const guard = await requireHelper(c.env, c.req.raw, c.req.param("id"));
  if ("response" in guard) return guard.response;
  return jsonResponse(safeSession(guard.meta));
});

app.post("/api/sessions/:id/commands", async (c) => {
  const guard = await requireHelper(c.env, c.req.raw, c.req.param("id"));
  if ("response" in guard) return guard.response;
  const payload = await readJson<{ body?: string; cwd?: string; timeoutSeconds?: number }>(c.req.raw);
  const body = cleanString(payload.body, maxCommandBytes).trim();
  if (!body) return jsonResponse({ error: "Command is required" }, 400);
  const command = await enqueueCommand(c.env, guard.meta.id, {
    type: "shell",
    body,
    cwd: cleanString(payload.cwd, 500),
    timeoutSeconds: normalizeTimeout(payload.timeoutSeconds)
  });
  await appendEvent(c.env, guard.meta.id, {
    type: "command_queued",
    message: `Queued command ${command.id}`,
    commandId: command.id
  });
  logInfo("command_queued", { sessionId: guard.meta.id, commandId: command.id, commandType: command.type });
  return jsonResponse({ commandId: command.id });
});

app.get("/api/sessions/:id/events", async (c) => {
  const guard = await requireHelper(c.env, c.req.raw, c.req.param("id"), { allowTerminal: true });
  if ("response" in guard) return guard.response;
  const after = cleanString(new URL(c.req.url).searchParams.get("after"), 80);
  const events = await listEvents(c.env, guard.meta.id, after);
  return jsonResponse({
    events,
    cursor: events.at(-1)?.id || after || "",
    status: guard.meta.status
  });
});

app.post("/api/sessions/:id/end", async (c) => {
  const guard = await requireHelper(c.env, c.req.raw, c.req.param("id"), { allowTerminal: true });
  if ("response" in guard) return guard.response;
  const now = Date.now();
  const meta = { ...guard.meta, status: "ended" as const, endedAt: now };
  await putJson(c.env, metaKey(meta.id), meta);
  await appendEvent(c.env, meta.id, {
    type: "session_ended",
    message: `Session ${meta.code} ended`,
    status: meta.status
  });
  logInfo("session_ended", { sessionId: meta.id });
  return jsonResponse({ ok: true, status: meta.status });
});

app.post("/api/sessions/:id/upload", async (c) => {
  const guard = await requireHelper(c.env, c.req.raw, c.req.param("id"));
  if ("response" in guard) return guard.response;
  const form = await c.req.raw.formData();
  const file = form.get("file");
  const path = cleanString(form.get("path"), 1000);
  if (!(file instanceof File)) return jsonResponse({ error: "File is required" }, 400);
  if (!path) return jsonResponse({ error: "Write path is required" }, 400);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > maxFileBytes) return jsonResponse({ error: "File exceeds 1 MB" }, 413);
  const uploadId = randomId();
  const uploadKey = `sessions/${guard.meta.id}/uploads/${uploadId}`;
  await c.env.SOE_MAILBOX.put(uploadKey, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: {
      name: file.name,
      path,
      size: String(bytes.byteLength)
    }
  });
  const command = await enqueueCommand(c.env, guard.meta.id, {
    type: "write-file",
    path,
    uploadKey,
    uploadName: file.name,
    uploadSize: bytes.byteLength,
    timeoutSeconds: 900
  });
  await appendEvent(c.env, guard.meta.id, {
    type: "upload_queued",
    message: `Queued write to ${path}`,
    commandId: command.id,
    path,
    size: bytes.byteLength
  });
  logInfo("upload_queued", { sessionId: guard.meta.id, commandId: command.id, bytes: bytes.byteLength });
  return jsonResponse({ commandId: command.id, uploadId });
});

app.post("/api/sessions/:id/download", async (c) => {
  const guard = await requireHelper(c.env, c.req.raw, c.req.param("id"));
  if ("response" in guard) return guard.response;
  const payload = await readJson<{ path?: string }>(c.req.raw);
  const path = cleanString(payload.path, 1000);
  if (!path) return jsonResponse({ error: "Read path is required" }, 400);
  const downloadId = randomId();
  const command = await enqueueCommand(c.env, guard.meta.id, {
    type: "read-file",
    path,
    downloadId,
    timeoutSeconds: 900
  });
  await appendEvent(c.env, guard.meta.id, {
    type: "download_queued",
    message: `Queued read from ${path}`,
    commandId: command.id,
    path
  });
  logInfo("download_queued", { sessionId: guard.meta.id, commandId: command.id });
  return jsonResponse({ commandId: command.id, downloadId });
});

app.get("/api/sessions/:id/downloads/:downloadId", async (c) => {
  const guard = await requireHelper(c.env, c.req.raw, c.req.param("id"), { allowTerminal: true });
  if ("response" in guard) return guard.response;
  const downloadId = cleanString(c.req.param("downloadId"), 200);
  const object = await c.env.SOE_MAILBOX.get(downloadKey(guard.meta.id, downloadId));
  if (!object) return jsonResponse({ error: "Download not found" }, 404);
  const path = object.customMetadata?.path || "download";
  return new Response(object.body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${safeFileName(path)}"`
    }
  });
});

app.post("/api/agent/:code/hello", async (c) => {
  const guard = await requireAgent(c.env, c.req.raw, c.req.param("code"));
  if ("response" in guard) return guard.response;
  const payload = await readJson<{ platform?: string; user?: string; cwd?: string }>(c.req.raw).catch((): { platform?: string; user?: string; cwd?: string } => ({}));
  const meta = { ...guard.meta, status: "connected" as const };
  await putJson(c.env, metaKey(meta.id), meta);
  await putJson(c.env, `sessions/${meta.id}/agent-state.json`, {
    platform: cleanString(payload.platform, 120),
    user: cleanString(payload.user, 120),
    cwd: cleanString(payload.cwd, 500),
    seenAt: Date.now()
  });
  await appendEvent(c.env, meta.id, {
    type: "agent_connected",
    message: `Agent connected as ${cleanString(payload.user, 120) || "unknown"}`,
    status: meta.status
  });
  logInfo("agent_connected", { sessionId: meta.id, platform: cleanString(payload.platform, 120) });
  return jsonResponse({ ok: true, status: meta.status, expiresAt: meta.expiresAt });
});

app.get("/api/agent/:code/next", async (c) => {
  const guard = await requireAgent(c.env, c.req.raw, c.req.param("code"));
  if ("response" in guard) return guard.response;
  const command = await nextQueuedCommand(c.env, guard.meta.id);
  if (!command) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  const running = { ...command, status: "running" as const, startedAt: Date.now() };
  await putJson(c.env, commandKey(guard.meta.id, command.id), running);
  await appendEvent(c.env, guard.meta.id, {
    type: "command_started",
    message: `Started ${command.type} ${command.id}`,
    commandId: command.id
  });
  logInfo("command_started", { sessionId: guard.meta.id, commandId: command.id, commandType: command.type });
  return commandResponse(c.env, running);
});

app.post("/api/agent/:code/ack", async (c) => {
  const guard = await requireAgent(c.env, c.req.raw, c.req.param("code"));
  if ("response" in guard) return guard.response;
  const payload = await readJson<{ commandId?: string }>(c.req.raw).catch((): { commandId?: string } => ({}));
  const commandId = cleanString(payload.commandId, 200);
  if (!commandId) return jsonResponse({ error: "Command id is required" }, 400);
  const command = await getJson<CommandRecord>(c.env, commandKey(guard.meta.id, commandId));
  if (!command) return jsonResponse({ error: "Command not found" }, 404);
  const running = { ...command, status: "running" as const, startedAt: command.startedAt || Date.now() };
  await putJson(c.env, commandKey(guard.meta.id, running.id), running);
  return jsonResponse({ ok: true });
});

app.post("/api/agent/:code/result/:commandId", async (c) => {
  const guard = await requireAgent(c.env, c.req.raw, c.req.param("code"), { allowTerminal: true });
  if ("response" in guard) return guard.response;
  const commandId = cleanString(c.req.param("commandId"), 200);
  const command = await getJson<CommandRecord>(c.env, commandKey(guard.meta.id, commandId));
  if (!command) return jsonResponse({ error: "Command not found" }, 404);
  const exitCode = Number(new URL(c.req.url).searchParams.get("exit") || "0");
  if (command.type === "read-file" && exitCode === 0) {
    const bytes = await c.req.raw.arrayBuffer();
    if (bytes.byteLength > maxFileBytes) return jsonResponse({ error: "File exceeds 1 MB" }, 413);
    const downloadId = command.downloadId || randomId();
    await c.env.SOE_MAILBOX.put(downloadKey(guard.meta.id, downloadId), bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        path: command.path || "download",
        size: String(bytes.byteLength)
      }
    });
    const done = { ...command, status: "completed" as const, completedAt: Date.now(), exitCode, downloadId };
    await putJson(c.env, commandKey(guard.meta.id, command.id), done);
    await appendEvent(c.env, guard.meta.id, {
      type: "download_ready",
      message: `Read ${bytes.byteLength} bytes from ${command.path}`,
      commandId: command.id,
      downloadId,
      path: command.path,
      size: bytes.byteLength,
      exitCode
    });
    logInfo("download_ready", { sessionId: guard.meta.id, commandId: command.id, bytes: bytes.byteLength });
    return jsonResponse({ ok: true });
  }
  const output = await readLimitedText(c.req.raw, maxResultBytes);
  const status = exitCode === 0 ? "completed" : "failed";
  const done = { ...command, status, completedAt: Date.now(), exitCode, output } satisfies CommandRecord;
  await putJson(c.env, commandKey(guard.meta.id, command.id), done);
  if (command.type === "write-file") {
    await appendEvent(c.env, guard.meta.id, {
      type: status === "completed" ? "upload_result" : "command_failed",
      message: status === "completed" ? `Wrote ${command.path}` : `Write failed for ${command.path}`,
      commandId: command.id,
      path: command.path,
      size: command.uploadSize,
      exitCode,
      output: output || undefined
    });
    logInfo("upload_result", { sessionId: guard.meta.id, commandId: command.id, exitCode, status });
  } else {
    await appendEvent(c.env, guard.meta.id, {
      type: status === "completed" ? "command_result" : "command_failed",
      message: `Command ${command.id} exited ${exitCode}`,
      commandId: command.id,
      exitCode,
      output
    });
    logInfo("command_result", { sessionId: guard.meta.id, commandId: command.id, exitCode, status });
  }
  return jsonResponse({ ok: true });
});

app.post("/api/agent/:code/bye", async (c) => {
  const guard = await requireAgent(c.env, c.req.raw, c.req.param("code"), { allowTerminal: true });
  if ("response" in guard) return guard.response;
  if (guard.meta.status !== "ended" && guard.meta.status !== "expired") {
    const meta = { ...guard.meta, status: "agent_stopped" as const };
    await putJson(c.env, metaKey(meta.id), meta);
    await appendEvent(c.env, meta.id, {
      type: "agent_stopped",
      message: "Agent stopped",
      status: meta.status
    });
    logInfo("agent_stopped", { sessionId: meta.id });
  }
  return jsonResponse({ ok: true });
});

app.get("/start/:file", async (c) => {
  const file = c.req.param("file");
  const token = cleanString(bearerToken(c.req.raw), 500);
  if (!token) return textResponse("Missing token", 400);
  if (file.endsWith(".sh")) {
    const code = cleanString(file.slice(0, -3), 40);
    const meta = await getSessionByCode(c.env, code);
    if (!meta) return textResponse("Session not found", 404);
    if (await sha256(token) !== meta.agentTokenHash) return textResponse("Unauthorized", 401);
    return textResponse(shellAgentScript(publicBaseUrl(c.req.raw, c.env), meta, token), 200, "text/x-shellscript");
  }
  if (file.endsWith(".ps1")) {
    const code = cleanString(file.slice(0, -4), 40);
    const meta = await getSessionByCode(c.env, code);
    if (!meta) return textResponse("Session not found", 404);
    if (await sha256(token) !== meta.agentTokenHash) return textResponse("Unauthorized", 401);
    return textResponse(powerShellAgentScript(publicBaseUrl(c.req.raw, c.env), meta, token), 200, "text/plain");
  }
  return textResponse("Not found", 404);
});

app.notFound((c) => {
  return c.req.path.startsWith("/api/") || c.req.path.startsWith("/start/") ? jsonResponse({ error: "Not found" }, 404) : textResponse("Not found\n", 404);
});

async function requireHelper(env: Env, request: Request, id: string, options: { allowTerminal?: boolean } = {}): Promise<HelperGuard> {
  const meta = await getJson<SessionMeta>(env, metaKey(cleanString(id, 200)));
  if (!meta) return { response: jsonResponse({ error: "Session not found" }, 404) };
  const token = bearerToken(request);
  if (!token || !constantTimeEqual(await sha256(token), meta.helperTokenHash)) {
    return { response: jsonResponse({ error: "Unauthorized" }, 401) };
  }
  const fresh = await expireIfNeeded(env, meta);
  if (!options.allowTerminal && (fresh.status === "ended" || fresh.status === "expired")) {
    return { response: jsonResponse({ error: `Session ${fresh.status}` }, 410) };
  }
  return { meta: fresh };
}

async function requireAgent(env: Env, request: Request, code: string, options: { allowTerminal?: boolean } = {}): Promise<AgentGuard> {
  const meta = await getSessionByCode(env, cleanString(code, 40));
  if (!meta) return { response: jsonResponse({ error: "Session not found" }, 404) };
  const token = bearerToken(request);
  if (!token || !constantTimeEqual(await sha256(token), meta.agentTokenHash)) {
    return { response: jsonResponse({ error: "Unauthorized" }, 401) };
  }
  const fresh = await expireIfNeeded(env, meta);
  if (!options.allowTerminal && fresh.status === "ended") {
    return { response: jsonResponse({ error: "Session ended" }, 410) };
  }
  if (!options.allowTerminal && fresh.status === "expired") {
    return { response: jsonResponse({ error: "Session expired" }, 410) };
  }
  return { meta: fresh };
}

function safeSession(meta: SessionMeta) {
  return {
    id: meta.id,
    code: meta.code,
    helperName: meta.helperName,
    status: meta.status,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt
  };
}
