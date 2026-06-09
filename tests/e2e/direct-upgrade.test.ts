import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { test } from "vitest";
import { strict as assert } from "node:assert";
import { publishDirectSignal, sendWithDirectFallback } from "../../src/client/direct-send";
import { app } from "../../src/worker/app";
import { createTestEnv } from "../helpers/fake-env";
import { startAppServer } from "../helpers/server";

console.info = () => {};

test("direct upgrade sends commands to an agent signal without using the relay data plane", async () => {
  const fixture = createTestEnv();
  const control = await startAppServer(app, fixture);
  const direct = await startDirectServer(async (payload) => ({
    status: 200,
    headers: {
      "X-Exit-Code": "0"
    },
    body: `direct:${payload.body}`
  }));

  try {
    const session = await createSession(control.baseUrl);
    const signal = await publishDirectSignal(control.baseUrl, session.id, {
      role: "agent",
      url: `${direct.baseUrl}/command`,
      priority: 1
    });
    assert.equal(signal.status, 201);

    const startedAt = performance.now();
    const response = await sendWithDirectFallback({
      baseUrl: control.baseUrl,
      sessionId: session.id,
      body: "printf direct-upgrade",
      timeoutSeconds: 10,
      directTimeoutMs: 200
    });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-SOE-Transport"), "direct");
    assert.ok(Number(response.headers.get("X-SOE-Direct-Latency-Ms") || "0") < 200);
    assert.equal(await response.text(), "direct:printf direct-upgrade");
    assert.ok(elapsedMs < 500, `direct upgrade took ${elapsedMs}ms`);
    assert.equal(direct.requests.length, 1);
    assert.equal(direct.requests[0]?.headers["x-soe-session-id"], session.id);
    assert.ok(direct.requests[0]?.headers["x-soe-signal-id"]);
    assert.equal(control.requests.some((request) => request.path.includes("/send")), false);
    assert.equal(control.requests.some((request) => request.path.includes("/next")), false);
    assert.equal(control.requests.some((request) => request.path.includes("/result/")), false);
  } finally {
    await direct.close();
    await control.close();
  }
});

test("failed direct upgrade falls back to relay without waiting for command timeout", async () => {
  const fixture = createTestEnv();
  const control = await startAppServer(app, fixture);
  const badDirect = await startDirectServer(async () => ({
    status: 404,
    headers: {},
    body: "missing"
  }));

  try {
    const session = await createSession(control.baseUrl);
    const signal = await publishDirectSignal(control.baseUrl, session.id, {
      role: "agent",
      url: `${badDirect.baseUrl}/missing`,
      priority: 1
    });
    assert.equal(signal.status, 201);

    const startedAt = performance.now();
    const send = sendWithDirectFallback({
      baseUrl: control.baseUrl,
      sessionId: session.id,
      body: "printf relay-fallback",
      timeoutSeconds: 10,
      directTimeoutMs: 100
    });

    const command = await waitForRelayCommand(control.baseUrl, session.id);
    assert.equal(command.body, "printf relay-fallback");
    const result = await fetch(`${control.baseUrl}/api/sessions/${session.id}/result/${command.id}?exit=0`, {
      method: "POST",
      body: "relay:fallback"
    });
    assert.equal(result.status, 200);

    const response = await send;
    const elapsedMs = performance.now() - startedAt;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-SOE-Transport"), "relay");
    assert.equal(await response.text(), "relay:fallback");
    assert.ok(elapsedMs < 1500, `fallback took ${elapsedMs}ms`);
    assert.equal(badDirect.requests.length, 1);
    assert.equal(control.requests.some((request) => request.path.includes("/send")), true);
    assert.equal(control.requests.some((request) => request.path.includes("/next")), true);
    assert.equal(control.requests.some((request) => request.path.includes("/result/")), true);
  } finally {
    await badDirect.close();
    await control.close();
  }
});

async function createSession(baseUrl: string): Promise<{ id: string }> {
  const response = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
  assert.equal(response.status, 200);
  const id = response.headers.get("X-Session-Id") || "";
  assert.match(id, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  await response.text();
  return { id };
}

async function waitForRelayCommand(baseUrl: string, sessionId: string): Promise<{ id: string; body: string }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/next`);
    if (response.status === 200) {
      const id = response.headers.get("X-Command-Id") || "";
      assert.ok(id);
      return { id, body: await response.text() };
    }
    assert.equal(response.status, 204);
    await sleep(25);
  }
  throw new Error("Timed out waiting for relay fallback command");
}

async function startDirectServer(handler: (payload: { body: string; cwd?: string; timeoutSeconds?: number }) => Promise<{
  status: number;
  headers: Record<string, string>;
  body: string;
}>): Promise<{
  baseUrl: string;
  requests: Array<{ path: string; headers: IncomingMessage["headers"] }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ path: string; headers: IncomingMessage["headers"] }> = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    requests.push({ path: request.url || "/", headers: request.headers });
    const body = JSON.parse(await requestBody(request) || "{}") as { body: string; cwd?: string; timeoutSeconds?: number };
    const result = await handler(body);
    response.statusCode = result.status;
    for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value);
    response.end(result.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start direct test server");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
