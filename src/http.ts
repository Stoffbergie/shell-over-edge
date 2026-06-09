import { maxCommandBytes } from "./config";
import type { Env } from "./types";

const textDecoder = new TextDecoder();

export class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
  }
}

export class BadRequestError extends Error {}

export async function readJson<T>(request: Request, maxBytes = maxCommandBytes): Promise<T> {
  if (!request.headers.get("content-type")?.includes("application/json")) return {} as T;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new PayloadTooLargeError(maxBytes);
  try {
    return JSON.parse(textDecoder.decode(bytes)) as T;
  } catch {
    throw new BadRequestError("Invalid JSON");
  }
}

export async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new PayloadTooLargeError(maxBytes);
  return textDecoder.decode(bytes);
}

export function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : "";
}

export function apiKey(request: Request): string {
  const value = (request.headers.get("x-api-key") || "").trim().toLowerCase();
  return isUuid(value) ? value : "";
}

export function requireSimpleCode(request: Request, codeParam: string): { code: string } | { response: Response } {
  const code = cleanString(codeParam, 80).toLowerCase();
  const key = apiKey(request);
  if (!code || !key || code !== key || !isUuid(code)) {
    return { response: jsonResponse({ error: "Unauthorized" }, 401) };
  }
  return { code };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

export function textResponse(value: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": contentType
    }
  });
}

export function publicBaseUrl(request: Request, env: Env): string {
  return (env.BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
}

export function legacyBridgeEnabled(env: Env): boolean {
  return env.ENABLE_LEGACY_BRIDGE === "true";
}

export function cleanString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

export function normalizeTimeout(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 900;
  return Math.min(Math.max(Math.trunc(parsed), 1), 3600);
}
