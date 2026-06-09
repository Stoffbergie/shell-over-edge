import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { Hono } from "hono";
import type { Env } from "../../src/worker/env";
import type { TestFixture } from "./fake-env";

export type RequestLog = {
  at: number;
  method: string;
  path: string;
  status: number;
};

export type TestServer = {
  baseUrl: string;
  requests: RequestLog[];
  close: () => Promise<void>;
};

export async function startAppServer(app: Hono<{ Bindings: Env }>, fixture: TestFixture): Promise<TestServer> {
  const requests: RequestLog[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = `${fixture.env.BASE_URL}${incoming.url || "/"}`;
      const headers = requestHeaders(incoming.headers);
      const body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await requestBody(incoming);
      const response = await app.request(url, {
        method: incoming.method,
        headers,
        body
      }, fixture.env, fixture.ctx);
      requests.push({ at: Date.now(), method: incoming.method || "GET", path: incoming.url || "/", status: response.status });
      outgoing.statusCode = response.status;
      outgoing.statusMessage = response.statusText;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      const bytes = Buffer.from(await response.arrayBuffer());
      outgoing.end(bytes);
    } catch (error) {
      requests.push({ at: Date.now(), method: incoming.method || "GET", path: incoming.url || "/", status: 500 });
      outgoing.statusCode = 500;
      outgoing.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start local test server");
  fixture.env.BASE_URL = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl: fixture.env.BASE_URL,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function requestHeaders(source: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
}

async function requestBody(request: IncomingMessage): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
