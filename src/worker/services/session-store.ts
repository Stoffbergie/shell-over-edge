import type { SessionMeta } from "../../domain/session";
import { cleanupRetentionMs } from "../../shared/config";
import type { Env } from "../env";

export async function expireIfNeeded(env: Env, meta: SessionMeta): Promise<SessionMeta> {
  if (Date.now() < meta.expiresAt || meta.status === "ended" || meta.status === "expired") return meta;
  const expired = { ...meta, status: "expired" as const };
  await putJson(env, metaKey(expired.id), expired);
  return expired;
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
      if (meta.code) await env.SOE_MAILBOX.delete(codeKey(meta.code));
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
  return `codes/${code}.json`;
}
