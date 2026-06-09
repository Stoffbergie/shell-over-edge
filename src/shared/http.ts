import type { Env } from "../worker/env";

const textDecoder = new TextDecoder();

export class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
  }
}

export class BadRequestError extends Error {}

export async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new PayloadTooLargeError(maxBytes);
  return textDecoder.decode(bytes);
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

export function cleanString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

export function normalizeTimeout(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 900;
  return Math.min(Math.max(Math.trunc(parsed), 1), 3600);
}
