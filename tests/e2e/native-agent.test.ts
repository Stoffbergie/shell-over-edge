import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { test } from "vitest";
import { strict as assert } from "node:assert";
import { app } from "../../src/worker/app";
import { createTestEnv } from "../helpers/fake-env";
import { startAppServer, type TestServer } from "../helpers/server";

console.info = () => {};

const nativeAgent = process.env.SOE_AGENT_BIN || join(process.cwd(), "zig-out", "bin", process.platform === "win32" ? "soe-agent.exe" : "soe-agent");
const skipNative = !isRunnableNativeAgent(nativeAgent);

test.skipIf(skipNative)("native agent connects and streams a command through the relay", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-native-e2e-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let output = () => "";
  try {
    const session = await createSession(server.baseUrl);
    agent = spawn(nativeAgent, ["--base-url", server.baseUrl, "--session", session.id], {
      cwd: dir,
      env: noProxyEnv()
    });
    output = captureOutput(agent);

    await waitForHello(server, agent, output, 10_000);

    const result = await sendCommand(server.baseUrl, session.id, printCommand("soe-native-e2e"), diagnostics(output, server));
    assert.equal(result.status, 200);
    assert.equal(normalizeOutput(result.text), "soe-native-e2e");

    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, output);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await rm(dir, { force: true, recursive: true });
    await server.close();
  }
});

test.skipIf(skipNative)("native agent answers probe and config control commands", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-native-control-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let output = () => "";
  try {
    const session = await createSession(server.baseUrl);
    agent = spawn(nativeAgent, ["--base-url", server.baseUrl, "--session", session.id], {
      cwd: dir,
      env: noProxyEnv()
    });
    output = captureOutput(agent);

    await waitForHello(server, agent, output, 10_000);

    const probe = await controlRequest(server.baseUrl, session.id, "probe", "", diagnostics(output, server));
    assert.equal(probe.status, 200);
    const probePayload = JSON.parse(probe.text) as { agent: { kind: string }; activeTransport: string; supports: { native: boolean; webrtcSignaling: boolean } };
    assert.equal(probePayload.agent.kind, "native");
    assert.equal(probePayload.activeTransport, "native");
    assert.equal(probePayload.supports.native, true);
    assert.equal(probePayload.supports.webrtcSignaling, true);

    const config = await controlRequest(server.baseUrl, session.id, "config", "webrtc", diagnostics(output, server));
    assert.equal(config.status, 200);
    const configPayload = JSON.parse(config.text) as { requested: string; active: string; fallback: boolean };
    assert.equal(configPayload.requested, "webrtc");
    assert.equal(configPayload.active, "native");
    assert.equal(configPayload.fallback, true);

    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, output);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await rm(dir, { force: true, recursive: true });
    await server.close();
  }
});

test.skipIf(skipNative)("native agent drains parallel relay sends without result mixups", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-native-parallel-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let output = () => "";
  try {
    const session = await createSession(server.baseUrl);
    agent = spawn(nativeAgent, ["--base-url", server.baseUrl, "--session", session.id], {
      cwd: dir,
      env: noProxyEnv()
    });
    output = captureOutput(agent);

    await waitForHello(server, agent, output, 10_000);

    const count = 8;
    const results = await Promise.all(Array.from({ length: count }, (_, index) => {
      const expected = `soe-native-parallel-${index}`;
      return sendCommand(server.baseUrl, session.id, printCommand(expected), diagnostics(output, server))
        .then((result) => ({ expected, result }));
    }));

    for (const item of results) {
      assert.equal(item.result.status, 200);
      assert.equal(normalizeOutput(item.result.text), item.expected);
    }

    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, output);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await rm(dir, { force: true, recursive: true });
    await server.close();
  }
});

test.skipIf(skipNative || process.platform === "win32")("native agent enforces command timeout and recovers", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-native-timeout-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let output = () => "";
  try {
    const session = await createSession(server.baseUrl);
    agent = spawn(nativeAgent, ["--base-url", server.baseUrl, "--session", session.id], {
      cwd: dir,
      env: noProxyEnv()
    });
    output = captureOutput(agent);

    await waitForHello(server, agent, output, 10_000);

    const startedAt = performance.now();
    const timedOut = await sendCommand(server.baseUrl, session.id, "sleep 5; printf too-late", diagnostics(output, server), 1);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(timedOut.status, 500);
    assert.match(timedOut.text, /timed out/i);
    assert.ok(elapsedMs < 4000, `native timeout took ${elapsedMs}ms\n${diagnostics(output, server)()}`);

    const recovered = await sendCommand(server.baseUrl, session.id, "printf recovered", diagnostics(output, server));
    assert.equal(recovered.status, 200);
    assert.equal(recovered.text, "recovered");

    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, output);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await rm(dir, { force: true, recursive: true });
    await server.close();
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

async function sendCommand(baseUrl: string, id: string, body: string, details = () => "", timeoutSeconds = 10): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}/api/sessions/${id}/send`, {
    method: "POST",
    body: JSON.stringify({ body, timeoutSeconds })
  });
  const result = { status: response.status, text: await response.text() };
  assert.notEqual(result.status, 504, `${result.text}\n${details()}`);
  return result;
}

async function controlRequest(baseUrl: string, id: string, name: "probe" | "config", body: string, details = () => ""): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}/api/sessions/${id}/${name}`, {
    method: name === "probe" ? "GET" : "POST",
    body: name === "probe" ? undefined : body
  });
  const result = { status: response.status, text: await response.text() };
  assert.notEqual(result.status, 504, `${result.text}\n${details()}`);
  return result;
}

async function endSession(baseUrl: string, id: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/sessions/${id}/end`, { method: "POST" });
  assert.equal(response.status, 200);
}

async function waitForHello(server: TestServer, child: ReturnType<typeof spawn>, output: () => string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (server.requests.some((request) => request.path.includes("/hello") && request.status === 200)) return;
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  throw new Error(`Native agent did not connect\n${diagnostics(output, server)()}`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number, output: () => string): Promise<void> {
  if (child.exitCode === null) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Native agent did not exit\n${output()}`)), timeoutMs);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
  assert.equal(child.exitCode, 0, output());
}

function captureOutput(child: ReturnType<typeof spawn>): () => string {
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  return () => Buffer.concat(chunks).toString("utf8");
}

function diagnostics(output: () => string, server: TestServer): () => string {
  return () => [
    "agent:",
    nativeAgent,
    "agent output:",
    output(),
    "session requests:",
    JSON.stringify(server.requests.filter((request) => request.path.includes("/api/sessions/")).slice(-40)),
    "recent requests:",
    JSON.stringify(server.requests.slice(-50))
  ].join("\n");
}

function noProxyEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost"
  };
}

function isRunnableNativeAgent(path: string): boolean {
  if (!existsSync(path)) return false;
  const result = spawnSync(path, [], { encoding: "utf8", timeout: 1000 });
  return !result.error;
}

function printCommand(value: string): string {
  return process.platform === "win32" ? `echo ${value}` : `printf ${value}`;
}

function normalizeOutput(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
