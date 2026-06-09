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

export function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

export async function json(response) {
  return JSON.parse(await response.text());
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
    this.fetch = fetch || (() => new Response("not implemented", { status: 501 }));
  }

  idFromName(name) {
    return name;
  }

  get(id) {
    return {
      fetch: (request, init) => this.fetch(id, request, init)
    };
  }
}
