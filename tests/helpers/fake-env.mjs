import { strict as assert } from "node:assert";

export function createTestEnv(options = {}) {
  const mailbox = new MemoryR2Bucket();
  const namespace = new FakeDurableObjectNamespace(options.bridgeFetch);
  return {
    env: {
      SOE_MAILBOX: mailbox,
      COMMAND_BRIDGES: namespace,
      BASE_URL: options.baseUrl || "https://soe.test",
      ENABLE_LEGACY_BRIDGE: options.legacyBridge ? "true" : undefined
    },
    mailbox,
    namespace,
    ctx: new TestExecutionContext()
  };
}

export async function text(response) {
  return response.text();
}

export async function createSession(app, fixture, path = "/api/sessions") {
  const response = await app.request(path, {
    method: "POST"
  }, fixture.env, fixture.ctx);
  assert.equal(response.status, 200);
  const id = response.headers.get("X-Session-Id");
  assert.match(id || "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return { id, code: id, script: await response.text(), contentType: response.headers.get("Content-Type") || "" };
}

export class TestExecutionContext {
  promises = [];
  props = {};

  waitUntil(promise) {
    this.promises.push(Promise.resolve(promise));
  }

  passThroughOnException() {}

  async drain() {
    await Promise.all(this.promises);
  }
}

class MemoryR2Bucket {
  objects = new Map();

  async put(key, value, options = {}) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value instanceof Uint8Array
        ? value
        : new TextEncoder().encode(String(value));
    this.objects.set(key, new MemoryR2Object(key, bytes, options));
    return null;
  }

  async get(key) {
    return this.objects.get(key) || null;
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  async list(options = {}) {
    const prefix = options.prefix || "";
    const objects = [...this.objects.values()]
      .filter((object) => object.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((object) => ({ key: object.key, size: object.size }));
    return { objects, truncated: false };
  }
}

class MemoryR2Object {
  constructor(key, bytes, options) {
    this.key = key;
    this.bytes = bytes;
    this.size = bytes.byteLength;
    this.httpMetadata = options.httpMetadata;
    this.customMetadata = options.customMetadata;
  }

  get body() {
    return new Response(this.bytes).body;
  }

  async text() {
    return new TextDecoder().decode(this.bytes);
  }

  async arrayBuffer() {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
  }
}

class FakeDurableObjectNamespace {
  constructor(fetch) {
    this.fetch = fetch;
    this.objects = new Map();
  }

  idFromName(name) {
    return name;
  }

  get(id) {
    if (!this.objects.has(id)) this.objects.set(id, new FakeSessionBridge());
    const object = this.objects.get(id);
    return {
      fetch: (request, init) => this.fetch ? this.fetch(id, request, init) : object.fetch(request, init)
    };
  }
}

class FakeSessionBridge {
  queued = [];
  nextWaiters = [];
  resultWaiters = new Map();
  session = null;

  async fetch(request, init = {}) {
    const url = new URL(String(request));
    const method = init.method || "GET";
    const body = init.body instanceof ReadableStream ? await new Response(init.body).text() : init.body == null ? "" : String(init.body);
    if (url.pathname === "/open") return this.open(body);
    if (url.pathname === "/hello") return this.hello();
    if (url.pathname === "/send") return this.send(body);
    if (url.pathname === "/next") return this.next();
    if (url.pathname.startsWith("/result/")) return this.result(url.pathname.slice("/result/".length), url.searchParams.get("exit"), body);
    if (url.pathname === "/end" && method === "POST") return this.end();
    return new Response("Not found\n", { status: 404 });
  }

  open(body) {
    const payload = JSON.parse(body);
    this.session = { expiresAt: Number(payload.expiresAt) };
    return textResponse("opened\n");
  }

  hello() {
    return this.requireOpen() || textResponse("connected\n");
  }

  async send(body) {
    const blocked = this.requireOpen();
    if (blocked) return blocked;
    const payload = JSON.parse(body);
    const command = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "shell",
      body: payload.body,
      cwd: payload.cwd || "",
      timeoutSeconds: payload.timeoutSeconds || 30
    };
    const response = new Promise((resolve) => {
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

  next() {
    const blocked = this.requireOpen();
    if (blocked) return blocked;
    const command = this.queued.shift();
    if (command) return commandResponse(command);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.nextWaiters = this.nextWaiters.filter((waiter) => waiter.resolve !== resolve);
        resolve(new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }));
      }, 25_000);
      this.nextWaiters.push({ resolve, timer });
    });
  }

  result(commandId, exit, body) {
    const blocked = this.requireOpen();
    if (blocked) return blocked;
    const waiter = this.resultWaiters.get(commandId);
    if (!waiter) return textResponse("Command not found\n", 404);
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
    return textResponse("ok\n");
  }

  end() {
    if (!this.session) return textResponse("Session not found\n", 404);
    this.session = { ...this.session, closed: true };
    for (const waiter of this.nextWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(textResponse("Session ended\n", 410));
    }
    for (const waiter of this.resultWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(textResponse("Session ended\n", 410));
    }
    this.queued = [];
    this.nextWaiters = [];
    this.resultWaiters.clear();
    return textResponse("ended\n");
  }

  dispatch(command) {
    const waiter = this.nextWaiters.shift();
    if (!waiter) {
      this.queued.push(command);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(commandResponse(command));
  }

  requireOpen() {
    if (!this.session) return textResponse("Session not found\n", 404);
    if (this.session.closed) return textResponse("Session ended\n", 410);
    if (Date.now() >= this.session.expiresAt) {
      this.session = { ...this.session, closed: true };
      return textResponse("Session expired\n", 410);
    }
    return null;
  }
}

function commandResponse(command) {
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

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}
