import { cleanupRetentionMs } from "./config";
import { base64Encode, randomCode, randomId } from "./crypto";
import { jsonResponse } from "./http";
import type { CodeIndex, CommandRecord, Env, EventRecord, SessionMeta } from "./types";

export async function expireIfNeeded(env: Env, meta: SessionMeta): Promise<SessionMeta> {
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

export async function createUniqueCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = randomCode();
    const existing = await getJson<CodeIndex>(env, codeKey(code));
    if (!existing) return code;
  }
  throw new Error("Could not allocate session code");
}

export async function getSessionByCode(env: Env, code: string): Promise<SessionMeta | null> {
  const index = await getJson<CodeIndex>(env, codeKey(code));
  if (!index) return null;
  return getJson<SessionMeta>(env, metaKey(index.id));
}

export async function enqueueCommand(env: Env, sessionId: string, input: Omit<CommandRecord, "id" | "status" | "createdAt">): Promise<CommandRecord> {
  const command: CommandRecord = {
    id: randomId(),
    status: "queued",
    createdAt: Date.now(),
    ...input
  };
  await putJson(env, commandKey(sessionId, command.id), command);
  const queue = (await getJson<string[]>(env, commandQueueKey(sessionId))) || [];
  queue.push(command.id);
  await putJson(env, commandQueueKey(sessionId), queue);
  return command;
}

export async function nextQueuedCommand(env: Env, sessionId: string): Promise<CommandRecord | null> {
  let queue = await getJson<string[]>(env, commandQueueKey(sessionId));
  if (!queue) {
    const commands = await listJsonObjects<CommandRecord>(env, `sessions/${sessionId}/commands/`);
    queue = commands
      .filter((command) => command.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((command) => command.id);
  }
  while (queue.length > 0) {
    const commandId = queue.shift();
    if (!commandId) continue;
    const command = await getJson<CommandRecord>(env, commandKey(sessionId, commandId));
    if (command?.status === "queued") {
      return command;
    }
  }
  return null;
}

export async function commandResponse(env: Env, command: CommandRecord): Promise<Response> {
  const headers = commandHeaders(command);
  if (command.type === "write-file") {
    const object = command.uploadKey ? await env.SOE_MAILBOX.get(command.uploadKey) : null;
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

export async function appendEvent(env: Env, sessionId: string, input: Omit<EventRecord, "id" | "ts">): Promise<EventRecord> {
  const event: EventRecord = {
    id: randomId(),
    ts: Date.now(),
    ...input
  };
  await putJson(env, eventKey(sessionId, event.id), event);
  const eventIds = (await getJson<string[]>(env, eventIndexKey(sessionId))) || [];
  eventIds.push(event.id);
  await putJson(env, eventIndexKey(sessionId), eventIds.slice(-500));
  return event;
}

export async function listEvents(env: Env, sessionId: string, after: string): Promise<EventRecord[]> {
  const eventIds = await getJson<string[]>(env, eventIndexKey(sessionId));
  const ids = eventIds
    ?.filter((eventId) => !after || eventId > after)
    .sort((a, b) => a.localeCompare(b))
    .slice(-100);
  const events = ids ? await listEventsById(env, sessionId, ids) : await listJsonObjects<EventRecord>(env, `sessions/${sessionId}/events/`);
  return events
    .filter((event) => !after || event.id > after)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(-100);
}

async function listEventsById(env: Env, sessionId: string, eventIds: string[]): Promise<EventRecord[]> {
  const events = await Promise.all(eventIds.map((eventId) => getJson<EventRecord>(env, eventKey(sessionId, eventId))));
  return events.filter((event): event is EventRecord => Boolean(event));
}

export async function cleanupExpiredSessions(env: Env): Promise<void> {
  const now = Date.now();
  const metas = await listJsonObjects<SessionMeta>(env, "sessions/", (key) => key.endsWith("/meta.json"));
  for (const meta of metas) {
    if (now >= meta.expiresAt && meta.status !== "ended" && meta.status !== "expired") {
      await expireIfNeeded(env, meta);
    }
    if (now >= meta.expiresAt + cleanupRetentionMs) {
      await deletePrefix(env, `sessions/${meta.id}/`);
      await env.SOE_MAILBOX.delete(codeKey(meta.code));
    }
  }
}

async function deletePrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.SOE_MAILBOX.list({ prefix, cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await env.SOE_MAILBOX.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function listJsonObjects<T>(env: Env, prefix: string, accept: (key: string) => boolean = () => true): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.SOE_MAILBOX.list({ prefix, cursor });
    for (const object of listed.objects) {
      if (!accept(object.key)) continue;
      const value = await getJson<T>(env, object.key);
      if (value) items.push(value);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return items;
}

export async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.SOE_MAILBOX.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" }
  });
}

export async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const object = await env.SOE_MAILBOX.get(key);
  if (!object) return null;
  return JSON.parse(await object.text()) as T;
}

export function metaKey(id: string): string {
  return `sessions/${id}/meta.json`;
}

export function codeKey(code: string): string {
  return `sessions/by-code/${code}.json`;
}

export function commandKey(sessionId: string, commandId: string): string {
  return `sessions/${sessionId}/commands/${commandId}.json`;
}

function commandQueueKey(sessionId: string): string {
  return `sessions/${sessionId}/command-queue.json`;
}

function eventKey(sessionId: string, eventId: string): string {
  return `sessions/${sessionId}/events/${eventId}.json`;
}

function eventIndexKey(sessionId: string): string {
  return `sessions/${sessionId}/event-index.json`;
}

export function downloadKey(sessionId: string, downloadId: string): string {
  return `sessions/${sessionId}/downloads/${downloadId}`;
}
