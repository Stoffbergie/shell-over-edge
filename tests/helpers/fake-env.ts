import { strict as assert } from "node:assert";
import type { Hono } from "hono";
import type { SessionMeta } from "../../src/domain/session";
import type { Env } from "../../src/worker/env";

type BridgeFetch = (id: string, request: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

type TestEnvOptions = {
  baseUrl?: string;
  bridgeFetch?: BridgeFetch;
  legacyBridge?: boolean;
};

export type TestFixture = {
  env: Env;
  mailbox: MemoryR2Bucket;
  namespace: FakeDurableObjectNamespace;
  ctx: ExecutionContext;
};

type BridgeCommand = {
  id: string;
  type: "shell";
  body: string;
  cwd: string;
  timeoutSeconds: number;
};

type BridgeWaiter = {
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createTestEnv(options: TestEnvOptions = {}): TestFixture {
  const mailbox = new MemoryR2Bucket();
  const namespace = new FakeDurableObjectNamespace(options.bridgeFetch);
  return {
    env: {
      SOE_MAILBOX: mailbox as unknown as R2Bucket,
      COMMAND_BRIDGES: namespace as unknown as DurableObjectNamespace,
      BASE_URL: options.baseUrl || "https://soe.test",
      ENABLE_LEGACY_BRIDGE: options.legacyBridge ? "true" : undefined
    },
    mailbox,
    namespace,
    ctx: new TestExecutionContext() as unknown as ExecutionContext
  };
}

export async function text(response: Response): Promise<string> {
  return response.text();
}

export async function createSession(app: Hono<{ Bindings: Env }>, fixture: TestFixture, path = "/api/sessions"): Promise<{
  id: string;
  code: string;
  script: string;
  contentType: string;
}> {
  const response = await app.request(path, {
    method: "POST"
  }, fixture.env, fixture.ctx);
  assert.equal(response.status, 200);
  const id = response.headers.get("X-Session-Id") || "";
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return { id, code: id, script: await response.text(), contentType: response.headers.get("Content-Type") || "" };
}

export class TestExecutionContext {
  promises: Promise<unknown>[] = [];
  props: Record<string, unknown> = {};

  waitUntil(promise: Promise<unknown>): void {
    this.promises.push(Promise.resolve(promise));
  }

  passThroughOnException(): void {}

  async drain(): Promise<void> {
    await Promise.all(this.promises);
  }
}

export class MemoryR2Bucket {
  objects = new Map<string, MemoryR2Object>();

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> } = {}): Promise<null> {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new TextEncoder().encode(String(value));
    this.objects.set(key, new MemoryR2Object(key, bytes, options));
    return null;
  }

  async get(key: string): Promise<MemoryR2Object | null> {
    return this.objects.get(key) || null;
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  async list(options: { prefix?: string; cursor?: string } = {}): Promise<{ objects: Array<{ key: string; size: number }>; truncated: false }> {
    const prefix = options.prefix || "";
    const objects = [...this.objects.values()]
      .filter((object) => object.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((object) => ({ key: object.key, size: object.size }));
    return { objects, truncated: false };
  }
}

class MemoryR2Object {
  constructor(
    readonly key: string,
    private readonly bytes: Uint8Array,
    readonly options: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }
  ) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  get body(): ReadableStream<Uint8Array> | null {
    return new Response(arrayBufferFromBytes(this.bytes)).body;
  }

  get httpMetadata(): R2HTTPMetadata | undefined {
    return this.options.httpMetadata;
  }

  get customMetadata(): Record<string, string> | undefined {
    return this.options.customMetadata;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return arrayBufferFromBytes(this.bytes);
  }
}

class FakeDurableObjectNamespace {
  private readonly objects = new Map<string, FakeSessionBridge>();

  constructor(private readonly bridgeFetch?: BridgeFetch) {}

  idFromName(name: string): string {
    return name;
  }

  get(id: string): { fetch: (request: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response> } {
    if (!this.objects.has(id)) this.objects.set(id, new FakeSessionBridge());
    const object = this.objects.get(id);
    if (!object) throw new Error(`Missing fake Durable Object ${id}`);
    return {
      fetch: (request, init) => this.bridgeFetch ? this.bridgeFetch(id, request, init) : object.fetch(request, init)
    };
  }
}

class FakeSessionBridge {
  private queued: BridgeCommand[] = [];
  private nextWaiters: BridgeWaiter[] = [];
  private resultWaiters = new Map<string, BridgeWaiter>();

  async fetch(request: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(request));
    const method = init.method || "GET";
    const body = await requestBody(init.body);
    if (url.pathname === "/send") return this.send(body);
    if (url.pathname === "/next") return this.next();
    if (url.pathname.startsWith("/result/")) return this.result(url.pathname.slice("/result/".length), url.searchParams.get("exit"), body);
    if (url.pathname === "/end" && method === "POST") return this.end();
    return new Response("Not found\n", { status: 404 });
  }

  private async send(body: string): Promise<Response> {
    const payload = JSON.parse(body) as Partial<SessionMeta> & { body?: string; cwd?: string; timeoutSeconds?: number };
    const command: BridgeCommand = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "shell",
      body: payload.body || "",
      cwd: payload.cwd || "",
      timeoutSeconds: payload.timeoutSeconds || 30
    };
    const response = new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.resultWaiters.delete(command.id);
        this.queued = this.queued.filter((item) => item.id !== command.id);
        resolve(new Response("Timed out waiting for command result\n", { status: 504 }));
      }, Math.min(command.timeoutSeconds * 1000 + 1000, 55_000));
      this.resultWaiters.set(command.id, { resolve, timer });
    });
    this.dispatch(command);
    return response;
  }

  private next(): Response | Promise<Response> {
    const command = this.queued.shift();
    if (command) return commandResponse(command);
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.nextWaiters = this.nextWaiters.filter((waiter) => waiter.resolve !== resolve);
        resolve(new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }));
      }, 25_000);
      this.nextWaiters.push({ resolve, timer });
    });
  }

  private result(commandId: string, exit: string | null, body: string): Response {
    const waiter = this.resultWaiters.get(commandId);
    if (!waiter) return new Response("Command not found\n", { status: 404 });
    const exitCode = Number(exit || "0");
    clearTimeout(waiter.timer);
    this.resultWaiters.delete(commandId);
    waiter.resolve(new Response(body, {
      status: exitCode === 0 ? 200 : 500,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Command-Id": commandId,
        "X-Exit-Code": String(exitCode)
      }
    }));
    return new Response("ok\n", { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  }

  private end(): Response {
    for (const waiter of this.nextWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(new Response("Session ended\n", { status: 410 }));
    }
    for (const waiter of this.resultWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(new Response("Session ended\n", { status: 410 }));
    }
    this.queued = [];
    this.nextWaiters = [];
    this.resultWaiters.clear();
    return new Response("ended\n", { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  }

  private dispatch(command: BridgeCommand): void {
    const waiter = this.nextWaiters.shift();
    if (!waiter) {
      this.queued.push(command);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(commandResponse(command));
  }
}

async function requestBody(body: BodyInit | null | undefined): Promise<string> {
  if (body instanceof ReadableStream) return new Response(body).text();
  if (body == null) return "";
  return String(body);
}

function commandResponse(command: BridgeCommand): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/octet-stream",
    "X-Command-Id": command.id,
    "X-Command-Type": command.type,
    "X-Command-Timeout": String(command.timeoutSeconds)
  });
  if (command.cwd) headers.set("X-Command-Cwd-Base64", Buffer.from(command.cwd).toString("base64"));
  return new Response(command.body, { headers });
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
