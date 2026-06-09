import { Hono } from "hono";

type Env = {
  REMOTE_MAILBOX: R2Bucket;
  ASSETS: Fetcher;
  BASE_URL?: string;
};

type SessionStatus = "waiting" | "connected" | "agent_stopped" | "ended" | "expired";
type CommandType = "shell" | "write-file" | "read-file";
type CommandStatus = "queued" | "running" | "completed" | "failed";

type SessionMeta = {
  id: string;
  code: string;
  helperName: string;
  helperTokenHash: string;
  agentTokenHash: string;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
  endedAt?: number;
  expiredEventWritten?: boolean;
};

type CodeIndex = {
  id: string;
  code: string;
  createdAt: number;
  expiresAt: number;
};

type CommandRecord = {
  id: string;
  type: CommandType;
  status: CommandStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  body?: string;
  cwd?: string;
  timeoutSeconds: number;
  path?: string;
  uploadKey?: string;
  uploadName?: string;
  uploadSize?: number;
  downloadId?: string;
  exitCode?: number;
  output?: string;
};

type EventRecord = {
  id: string;
  ts: number;
  type: string;
  message: string;
  commandId?: string;
  output?: string;
  status?: SessionStatus;
  exitCode?: number;
  downloadId?: string;
  path?: string;
  size?: number;
};

type HelperGuard = { meta: SessionMeta } | { response: Response };
type AgentGuard = { meta: SessionMeta } | { response: Response };

const app = new Hono<{ Bindings: Env }>();
const sessionTtlMs = 2 * 60 * 60 * 1000;
const cleanupRetentionMs = 24 * 60 * 60 * 1000;
const maxFileBytes = 1024 * 1024;
const maxResultBytes = 1024 * 1024;
const textEncoder = new TextEncoder();

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
});

app.post("/api/sessions", async (c) => {
  await cleanupExpiredSessions(c.env);
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
  const baseUrl = publicBaseUrl(c.req.raw, c.env);
  return jsonResponse({
    id,
    code,
    helperName,
    status: meta.status,
    expiresAt: meta.expiresAt,
    helperToken,
    agentToken,
    shellCommand: `curl -fsSL ${quoteShell(`${baseUrl}/start/${code}.sh?token=${encodeURIComponent(agentToken)}`)} | sh`,
    windowsCommand: `irm "${baseUrl}/start/${code}.ps1?token=${encodeURIComponent(agentToken)}" | iex`
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
  const body = cleanString(payload.body, maxResultBytes).trim();
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
  await c.env.REMOTE_MAILBOX.put(uploadKey, bytes, {
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
  return jsonResponse({ commandId: command.id, downloadId });
});

app.get("/api/sessions/:id/downloads/:downloadId", async (c) => {
  const guard = await requireHelper(c.env, c.req.raw, c.req.param("id"), { allowTerminal: true });
  if ("response" in guard) return guard.response;
  const downloadId = cleanString(c.req.param("downloadId"), 200);
  const object = await c.env.REMOTE_MAILBOX.get(downloadKey(guard.meta.id, downloadId));
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
  return commandResponse(c.env, guard.meta.id, running);
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
    await c.env.REMOTE_MAILBOX.put(downloadKey(guard.meta.id, downloadId), bytes, {
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
  } else {
    await appendEvent(c.env, guard.meta.id, {
      type: status === "completed" ? "command_result" : "command_failed",
      message: `Command ${command.id} exited ${exitCode}`,
      commandId: command.id,
      exitCode,
      output
    });
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
  }
  return jsonResponse({ ok: true });
});

app.get("/start/:file", async (c) => {
  const file = c.req.param("file");
  const token = cleanString(new URL(c.req.url).searchParams.get("token"), 500);
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

app.get("/", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/app.js", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/styles.css", (c) => c.env.ASSETS.fetch(c.req.raw));

app.notFound((c) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/start/")) {
    return jsonResponse({ error: "Not found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
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

async function expireIfNeeded(env: Env, meta: SessionMeta): Promise<SessionMeta> {
  if (Date.now() < meta.expiresAt || meta.status === "ended" || meta.status === "expired") return meta;
  const expired = { ...meta, status: "expired" as const, expiredEventWritten: true };
  await putJson(env, metaKey(expired.id), expired);
  if (!meta.expiredEventWritten) {
    await appendEvent(env, expired.id, {
      type: "session_expired",
      message: `Session ${expired.code} expired`,
      status: expired.status
    });
  }
  return expired;
}

async function createUniqueCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = randomCode();
    const existing = await getJson<CodeIndex>(env, codeKey(code));
    if (!existing) return code;
  }
  throw new Error("Could not allocate session code");
}

async function getSessionByCode(env: Env, code: string): Promise<SessionMeta | null> {
  const index = await getJson<CodeIndex>(env, codeKey(code));
  if (!index) return null;
  return getJson<SessionMeta>(env, metaKey(index.id));
}

async function enqueueCommand(env: Env, sessionId: string, input: Omit<CommandRecord, "id" | "status" | "createdAt">): Promise<CommandRecord> {
  const command: CommandRecord = {
    id: randomId(),
    status: "queued",
    createdAt: Date.now(),
    ...input
  };
  await putJson(env, commandKey(sessionId, command.id), command);
  return command;
}

async function nextQueuedCommand(env: Env, sessionId: string): Promise<CommandRecord | null> {
  const commands = await listJsonObjects<CommandRecord>(env, `sessions/${sessionId}/commands/`);
  commands.sort((a, b) => a.createdAt - b.createdAt);
  return commands.find((command) => command.status === "queued") || null;
}

async function commandResponse(env: Env, sessionId: string, command: CommandRecord): Promise<Response> {
  const headers = commandHeaders(command);
  if (command.type === "write-file") {
    const object = command.uploadKey ? await env.REMOTE_MAILBOX.get(command.uploadKey) : null;
    if (!object) return jsonResponse({ error: "Upload not found" }, 404);
    return new Response(object.body, { status: 200, headers });
  }
  if (command.type === "read-file") {
    return new Response("", { status: 200, headers });
  }
  return new Response(command.body || "", { status: 200, headers });
}

function commandHeaders(command: CommandRecord): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/octet-stream",
    "X-Command-Id": command.id,
    "X-Command-Type": command.type,
    "X-Command-Timeout": String(command.timeoutSeconds)
  });
  if (command.cwd) headers.set("X-Command-Cwd-Base64", base64Encode(command.cwd));
  if (command.path) headers.set("X-Command-Path-Base64", base64Encode(command.path));
  if (command.uploadName) headers.set("X-Command-Upload-Name-Base64", base64Encode(command.uploadName));
  if (command.downloadId) headers.set("X-Download-Id", command.downloadId);
  return headers;
}

async function appendEvent(env: Env, sessionId: string, input: Omit<EventRecord, "id" | "ts">): Promise<EventRecord> {
  const event: EventRecord = {
    id: randomId(),
    ts: Date.now(),
    ...input
  };
  await putJson(env, eventKey(sessionId, event.id), event);
  return event;
}

async function listEvents(env: Env, sessionId: string, after: string): Promise<EventRecord[]> {
  const events = await listJsonObjects<EventRecord>(env, `sessions/${sessionId}/events/`);
  return events
    .filter((event) => !after || event.id > after)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(-100);
}

async function cleanupExpiredSessions(env: Env): Promise<void> {
  const now = Date.now();
  const metas = await listJsonObjects<SessionMeta>(env, "sessions/", (key) => key.endsWith("/meta.json"));
  for (const meta of metas) {
    if (now >= meta.expiresAt && meta.status !== "ended" && meta.status !== "expired") {
      await expireIfNeeded(env, meta);
    }
    if (now >= meta.expiresAt + cleanupRetentionMs) {
      await deletePrefix(env, `sessions/${meta.id}/`);
      await env.REMOTE_MAILBOX.delete(codeKey(meta.code));
    }
  }
}

async function deletePrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.REMOTE_MAILBOX.list({ prefix, cursor });
    for (const object of listed.objects) {
      await env.REMOTE_MAILBOX.delete(object.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function listJsonObjects<T>(env: Env, prefix: string, accept: (key: string) => boolean = () => true): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.REMOTE_MAILBOX.list({ prefix, cursor });
    for (const object of listed.objects) {
      if (!accept(object.key)) continue;
      const value = await getJson<T>(env, object.key);
      if (value) items.push(value);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return items;
}

async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.REMOTE_MAILBOX.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" }
  });
}

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const object = await env.REMOTE_MAILBOX.get(key);
  if (!object) return null;
  return JSON.parse(await object.text()) as T;
}

async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.includes("application/json")) return {} as T;
  return request.json() as Promise<T>;
}

async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  const bytes = await request.arrayBuffer();
  const view = bytes.byteLength > maxBytes ? bytes.slice(0, maxBytes) : bytes;
  const suffix = bytes.byteLength > maxBytes ? "\n[truncated]" : "";
  return new TextDecoder().decode(view) + suffix;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : "";
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function textResponse(value: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": contentType
    }
  });
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

function publicBaseUrl(request: Request, env: Env): string {
  return (env.BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
}

function cleanString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function normalizeTimeout(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 900;
  return Math.min(Math.max(Math.trunc(parsed), 1), 3600);
}

function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `BR-${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function randomToken(): string {
  return randomBase64Url(32);
}

function randomId(): string {
  return `${Date.now()}-${randomBase64Url(8)}`;
}

function randomBase64Url(size: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64Encode(value: string): string {
  const bytes = textEncoder.encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function safeFileName(path: string): string {
  return (path.split(/[\\/]/).pop() || "download").replace(/["\r\n]/g, "_");
}

function metaKey(id: string): string {
  return `sessions/${id}/meta.json`;
}

function codeKey(code: string): string {
  return `sessions/by-code/${code}.json`;
}

function commandKey(sessionId: string, commandId: string): string {
  return `sessions/${sessionId}/commands/${commandId}.json`;
}

function eventKey(sessionId: string, eventId: string): string {
  return `sessions/${sessionId}/events/${eventId}.json`;
}

function downloadKey(sessionId: string, downloadId: string): string {
  return `sessions/${sessionId}/downloads/${downloadId}`;
}

function shellAgentScript(baseUrl: string, meta: SessionMeta, token: string): string {
  return `#!/bin/sh
set -u
BASE_URL=${quoteShell(baseUrl)}
CODE=${quoteShell(meta.code)}
TOKEN=${quoteShell(token)}
HELPER=${quoteShell(meta.helperName)}
EXPIRES=${quoteShell(new Date(meta.expiresAt).toISOString())}
POLL_SECONDS=2

decode_b64() {
  if command -v base64 >/dev/null 2>&1; then
    printf '%s' "$1" | base64 --decode 2>/dev/null || printf '%s' "$1" | base64 -D 2>/dev/null || printf ''
  else
    printf ''
  fi
}

header_value() {
  awk -F': ' -v name="$1" 'tolower($1) == tolower(name) { sub("\\r$", "", $2); print $2; exit }' "$2"
}

post_bye() {
  curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agent/$CODE/bye" >/dev/null 2>&1 || true
}

run_shell() {
  command_body=$1
  cwd=$2
  timeout_seconds=$3
  output_file=$4
  if [ -n "$cwd" ]; then
    if [ ! -d "$cwd" ]; then
      printf 'Working directory does not exist: %s\\n' "$cwd" > "$output_file"
      return 1
    fi
    run_prefix="cd $(printf '%s' "$cwd" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/") && "
  else
    run_prefix=""
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" sh -c "$run_prefix$command_body" > "$output_file" 2>&1
  else
    sh -c "$run_prefix$command_body" > "$output_file" 2>&1
  fi
}

write_file() {
  source_file=$1
  target_path=$2
  output_file=$3
  if [ -z "$target_path" ]; then
    printf 'Missing target path\\n' > "$output_file"
    return 1
  fi
  parent_dir=$(dirname "$target_path")
  mkdir -p "$parent_dir" 2>/dev/null || true
  cp "$source_file" "$target_path" > "$output_file" 2>&1
  status=$?
  if [ "$status" -eq 0 ]; then
    size=$(wc -c < "$target_path" | tr -d ' ')
    printf 'Wrote %s bytes to %s\\n' "$size" "$target_path" > "$output_file"
  fi
  return "$status"
}

read_file() {
  target_path=$1
  output_file=$2
  if [ ! -f "$target_path" ]; then
    printf 'File not found: %s\\n' "$target_path" > "$output_file"
    return 1
  fi
  cp "$target_path" "$output_file"
}

printf '\\nBuddy Dev Support\\n\\nSession: %s\\nHelper: %s\\nAccess: command runner + file transfer\\nExpires: %s\\n\\nStop anytime: Ctrl+C\\n\\n' "$CODE" "$HELPER" "$EXPIRES"
trap 'post_bye; exit 0' INT TERM EXIT
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data "{\"platform\":\"$(uname -s)\",\"user\":\"$(whoami)\",\"cwd\":\"$(pwd | sed 's/"/\\\\"/g')\"}" "$BASE_URL/api/agent/$CODE/hello" >/dev/null

while true; do
  headers_file=$(mktemp)
  body_file=$(mktemp)
  status_code=$(curl -sS -D "$headers_file" -o "$body_file" -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agent/$CODE/next" || printf '000')
  if [ "$status_code" = "204" ]; then
    rm -f "$headers_file" "$body_file"
    sleep "$POLL_SECONDS"
    continue
  fi
  if [ "$status_code" = "410" ] || [ "$status_code" = "404" ] || [ "$status_code" = "401" ]; then
    cat "$body_file"
    printf '\\n'
    rm -f "$headers_file" "$body_file"
    exit 0
  fi
  if [ "$status_code" != "200" ]; then
    cat "$body_file"
    printf '\\n'
    rm -f "$headers_file" "$body_file"
    sleep "$POLL_SECONDS"
    continue
  fi
  command_id=$(header_value X-Command-Id "$headers_file")
  command_type=$(header_value X-Command-Type "$headers_file")
  cwd=$(decode_b64 "$(header_value X-Command-Cwd-Base64 "$headers_file")")
  target_path=$(decode_b64 "$(header_value X-Command-Path-Base64 "$headers_file")")
  timeout_seconds=$(header_value X-Command-Timeout "$headers_file")
  [ -n "$timeout_seconds" ] || timeout_seconds=900
  result_file=$(mktemp)
  if [ "$command_type" = "shell" ]; then
    command_body=$(cat "$body_file")
    run_shell "$command_body" "$cwd" "$timeout_seconds" "$result_file"
    exit_code=$?
  elif [ "$command_type" = "write-file" ]; then
    write_file "$body_file" "$target_path" "$result_file"
    exit_code=$?
  elif [ "$command_type" = "read-file" ]; then
    read_file "$target_path" "$result_file"
    exit_code=$?
  else
    printf 'Unknown command type: %s\\n' "$command_type" > "$result_file"
    exit_code=1
  fi
  curl -fsS -X POST -H "Authorization: Bearer $TOKEN" --data-binary "@$result_file" "$BASE_URL/api/agent/$CODE/result/$command_id?exit=$exit_code" >/dev/null || true
  rm -f "$headers_file" "$body_file" "$result_file"
done
`;
}

function powerShellAgentScript(baseUrl: string, meta: SessionMeta, token: string): string {
  return `$ErrorActionPreference = "Stop"
$BaseUrl = ${quotePowerShell(baseUrl)}
$Code = ${quotePowerShell(meta.code)}
$Token = ${quotePowerShell(token)}
$Helper = ${quotePowerShell(meta.helperName)}
$Expires = ${quotePowerShell(new Date(meta.expiresAt).toISOString())}
$Headers = @{ Authorization = "Bearer $Token" }

function Decode-Base64Text([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Invoke-AgentRequest {
  param([string]$Method, [string]$Path, [string]$OutFile, [object]$Body, [string]$ContentType)
  $Parameters = @{
    Uri = "$BaseUrl$Path"
    Method = $Method
    Headers = $Headers
    UseBasicParsing = $true
  }
  if ($OutFile) { $Parameters.OutFile = $OutFile }
  if ($null -ne $Body) { $Parameters.Body = $Body }
  if ($ContentType) { $Parameters.ContentType = $ContentType }
  try {
    return Invoke-WebRequest @Parameters
  } catch {
    if ($_.Exception.Response) { return $_.Exception.Response }
    throw
  }
}

function Send-Bye {
  try { Invoke-AgentRequest -Method Post -Path "/api/agent/$Code/bye" | Out-Null } catch {}
}

function Run-Command([string]$CommandBody, [string]$Cwd, [string]$ResultFile) {
  $Previous = Get-Location
  try {
    if ($Cwd) { Set-Location $Cwd }
    $Output = & ([scriptblock]::Create($CommandBody)) *>&1 | Out-String
    $ExitCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
    [IO.File]::WriteAllText($ResultFile, $Output)
    return $ExitCode
  } catch {
    [IO.File]::WriteAllText($ResultFile, $_.Exception.Message)
    return 1
  } finally {
    Set-Location $Previous
  }
}

function Write-RemoteFile([string]$SourceFile, [string]$TargetPath, [string]$ResultFile) {
  try {
    $Parent = Split-Path -Parent $TargetPath
    if ($Parent) { New-Item -ItemType Directory -Path $Parent -Force | Out-Null }
    [IO.File]::WriteAllBytes($TargetPath, [IO.File]::ReadAllBytes($SourceFile))
    $Size = (Get-Item $TargetPath).Length
    [IO.File]::WriteAllText($ResultFile, "Wrote $Size bytes to $TargetPath")
    return 0
  } catch {
    [IO.File]::WriteAllText($ResultFile, $_.Exception.Message)
    return 1
  }
}

function Read-RemoteFile([string]$TargetPath, [string]$ResultFile) {
  try {
    if (!(Test-Path -LiteralPath $TargetPath -PathType Leaf)) { throw "File not found: $TargetPath" }
    [IO.File]::WriteAllBytes($ResultFile, [IO.File]::ReadAllBytes($TargetPath))
    return 0
  } catch {
    [IO.File]::WriteAllText($ResultFile, $_.Exception.Message)
    return 1
  }
}

Write-Host ""
Write-Host "Buddy Dev Support"
Write-Host ""
Write-Host "Session: $Code"
Write-Host "Helper: $Helper"
Write-Host "Access: command runner + file transfer"
Write-Host "Expires: $Expires"
Write-Host ""
Write-Host "Stop anytime: Ctrl+C"
Write-Host ""

[Console]::TreatControlCAsInput = $false
try {
  Invoke-AgentRequest -Method Post -Path "/api/agent/$Code/hello" -Body (@{ platform = $PSVersionTable.Platform; user = [Environment]::UserName; cwd = (Get-Location).Path } | ConvertTo-Json -Compress) -ContentType "application/json" | Out-Null
  while ($true) {
    $BodyFile = [IO.Path]::GetTempFileName()
    $ResultFile = [IO.Path]::GetTempFileName()
    $Response = Invoke-AgentRequest -Method Get -Path "/api/agent/$Code/next" -OutFile $BodyFile
    $StatusCode = [int]$Response.StatusCode
    if ($StatusCode -eq 204) {
      Remove-Item $BodyFile, $ResultFile -Force
      Start-Sleep -Seconds 2
      continue
    }
    if ($StatusCode -eq 410 -or $StatusCode -eq 401 -or $StatusCode -eq 404) {
      if (Test-Path $BodyFile) { Get-Content $BodyFile -Raw | Write-Host }
      Remove-Item $BodyFile, $ResultFile -Force
      break
    }
    if ($StatusCode -ne 200) {
      if (Test-Path $BodyFile) { Get-Content $BodyFile -Raw | Write-Host }
      Remove-Item $BodyFile, $ResultFile -Force
      Start-Sleep -Seconds 2
      continue
    }
    $CommandId = [string]$Response.Headers["X-Command-Id"]
    $CommandType = [string]$Response.Headers["X-Command-Type"]
    $Cwd = Decode-Base64Text ([string]$Response.Headers["X-Command-Cwd-Base64"])
    $TargetPath = Decode-Base64Text ([string]$Response.Headers["X-Command-Path-Base64"])
    if ($CommandType -eq "shell") {
      $ExitCode = Run-Command -CommandBody (Get-Content $BodyFile -Raw) -Cwd $Cwd -ResultFile $ResultFile
    } elseif ($CommandType -eq "write-file") {
      $ExitCode = Write-RemoteFile -SourceFile $BodyFile -TargetPath $TargetPath -ResultFile $ResultFile
    } elseif ($CommandType -eq "read-file") {
      $ExitCode = Read-RemoteFile -TargetPath $TargetPath -ResultFile $ResultFile
    } else {
      [IO.File]::WriteAllText($ResultFile, "Unknown command type: $CommandType")
      $ExitCode = 1
    }
    Invoke-AgentRequest -Method Post -Path "/api/agent/$Code/result/$CommandId?exit=$ExitCode" -Body ([IO.File]::ReadAllBytes($ResultFile)) -ContentType "application/octet-stream" | Out-Null
    Remove-Item $BodyFile, $ResultFile -Force
  }
} finally {
  Send-Bye
}
`;
}

function quotePowerShell(value: string): string {
  return `"${value.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, "`\"")}"`;
}

export default {
  fetch: app.fetch,
  scheduled: async (_event, env) => {
    await cleanupExpiredSessions(env);
  }
} satisfies ExportedHandler<Env>;
