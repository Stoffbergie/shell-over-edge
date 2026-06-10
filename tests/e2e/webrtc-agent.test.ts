import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "vitest";
import { strict as assert } from "node:assert";
import { app } from "../../src/worker/app";
import { createTestEnv } from "../helpers/fake-env";
import { findCommand } from "../helpers/commands";
import { startAppServer, type TestServer } from "../helpers/server";

console.info = () => {};

const webrtcDriver = process.env.SOE_WEBRTC_BIN || join(process.cwd(), "dist", "webrtc", process.platform === "win32" ? "soe-webrtc.exe" : "soe-webrtc");
const skipWebRtc = !existsSync(webrtcDriver);
const sh = findCommand("sh");
const curl = findCommand("curl");

test.skipIf(skipWebRtc)("WebRTC sidecar sends a shell command over RTCDataChannel", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-webrtc-e2e-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let agentOutput = () => "";
  try {
    const session = await createSession(server.baseUrl);
    agent = spawn(webrtcDriver, ["agent", "--base-url", server.baseUrl, "--session", session.id, "--connect-timeout", "15"], {
      cwd: dir,
      env: noProxyEnv()
    });
    agentOutput = captureOutput(agent);

    const first = await runDriver([
      "send",
      "--base-url", server.baseUrl,
      "--session", session.id,
      "--connect-timeout", "15",
      "--timeout", "5",
      "--body", printCommand("webrtc-e2e-1")
    ], dir);

    assert.equal(first.code, 0, `${first.output}\n${diagnostics(agentOutput, server)()}`);
    assert.equal(normalizeOutput(first.output), "webrtc-e2e-1");
    const second = await runDriver([
      "send",
      "--base-url", server.baseUrl,
      "--session", session.id,
      "--connect-timeout", "15",
      "--timeout", "5",
      "--body", printCommand("webrtc-e2e-2")
    ], dir);

    assert.equal(second.code, 0, `${second.output}\n${diagnostics(agentOutput, server)()}`);
    assert.equal(normalizeOutput(second.output), "webrtc-e2e-2");
    assert.equal(controlPlaneUsed(server, "/send"), false);
    assert.equal(controlPlaneUsed(server, "/next"), false);
    assert.equal(controlPlaneUsed(server, "/result/"), false);
    assert.ok(controlPlaneUsed(server, "/signals"));
    assert.ok(controlPlaneUsed(server, "/ice"));
    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, agentOutput);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await rm(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
    await server.close();
  }
});

test.skipIf(skipWebRtc || process.platform === "win32")("WebRTC sidecar returns remote timeout failures", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-webrtc-timeout-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let agentOutput = () => "";
  try {
    const session = await createSession(server.baseUrl);
    agent = spawn(webrtcDriver, ["agent", "--base-url", server.baseUrl, "--session", session.id, "--connect-timeout", "15"], {
      cwd: dir,
      env: noProxyEnv()
    });
    agentOutput = captureOutput(agent);

    const sender = await runDriver([
      "send",
      "--base-url", server.baseUrl,
      "--session", session.id,
      "--connect-timeout", "15",
      "--timeout", "1",
      "--body", "sleep 5; printf too-late"
    ], dir);

    assert.equal(sender.code, 124, `${sender.output}\n${diagnostics(agentOutput, server)()}`);
    assert.match(sender.output, /timed out/i);
    const recovered = await runDriver([
      "send",
      "--base-url", server.baseUrl,
      "--session", session.id,
      "--connect-timeout", "15",
      "--timeout", "5",
      "--body", "printf recovered"
    ], dir);

    assert.equal(recovered.code, 0, `${recovered.output}\n${diagnostics(agentOutput, server)()}`);
    assert.equal(normalizeOutput(recovered.output), "recovered");
    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, agentOutput);
    assert.equal(controlPlaneUsed(server, "/send"), false);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await rm(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
    await server.close();
  }
});

test.skipIf(skipWebRtc || process.platform === "win32" || !sh || !curl)("generated POSIX agent upgrades to real WebRTC sidecar through config", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const assets = await startBinaryAssetServer(webrtcDriver);
  const dir = await mkdtemp(join(tmpdir(), "soe-webrtc-config-e2e-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let agentOutput = () => "";
  try {
    const session = await createScriptSession(server.baseUrl);
    const scriptPath = join(dir, "agent.sh");
    await writeFile(scriptPath, session.script, { mode: 0o700 });
    agent = spawn(sh, [scriptPath], {
      cwd: dir,
      env: {
        ...noProxyEnv(),
        SOE_WEBRTC_URL: assets.url
      }
    });
    agentOutput = captureOutput(agent);

    await waitForHello(server, agent, agentOutput, 10_000);

    const config = await controlRequest(server.baseUrl, session.id, "config", "webrtc", diagnostics(agentOutput, server));
    assert.equal(config.status, 200);
    const configPayload = JSON.parse(config.text) as { requested: string; active: string; upgraded: boolean; fallback: boolean };
    assert.equal(configPayload.requested, "webrtc");
    assert.equal(configPayload.active, "webrtc");
    assert.equal(configPayload.upgraded, true);
    assert.equal(configPayload.fallback, false);
    assert.ok(assets.requests.length > 0);

    const firstDataRequest = server.requests.length;
    const sender = await runDriver([
      "send",
      "--base-url", server.baseUrl,
      "--session", session.id,
      "--connect-timeout", "15",
      "--timeout", "5",
      "--body", printCommand("config-webrtc-e2e")
    ], dir);

    assert.equal(sender.code, 0, `${sender.output}\n${diagnostics(agentOutput, server)()}`);
    assert.equal(normalizeOutput(sender.output), "config-webrtc-e2e");
    assert.equal(controlPlaneUsedSince(server, "/send", firstDataRequest), false);
    assert.ok(controlPlaneUsedSince(server, "/signals", firstDataRequest));
    assert.ok(controlPlaneUsedSince(server, "/ice", firstDataRequest));

    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, agentOutput);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await assets.close();
    await rm(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
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

async function createScriptSession(baseUrl: string): Promise<{ id: string; script: string }> {
  const response = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
  assert.equal(response.status, 200);
  const id = response.headers.get("X-Session-Id") || "";
  assert.match(id, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  return { id, script: await response.text() };
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
  throw new Error(`Generated agent did not connect\n${diagnostics(output, server)()}`);
}

async function runDriver(args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  const child = spawn(webrtcDriver, args, { cwd, env: noProxyEnv() });
  const output = captureOutput(child);
  await waitForExit(child, 30_000, output, false);
  return { code: child.exitCode, output: output() };
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number, output: () => string, assertSuccess = true): Promise<void> {
  if (child.exitCode === null) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`WebRTC driver did not exit\n${output()}`)), timeoutMs);
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
  if (assertSuccess) assert.equal(child.exitCode, 0, output());
}

function captureOutput(child: ReturnType<typeof spawn>): () => string {
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  return () => Buffer.concat(chunks).toString("utf8");
}

function diagnostics(output: () => string, server: TestServer): () => string {
  return () => [
    "driver:",
    webrtcDriver,
    "agent output:",
    output(),
    "session requests:",
    JSON.stringify(server.requests.filter((request) => request.path.includes("/api/sessions/")).slice(-80))
  ].join("\n");
}

function controlPlaneUsed(server: TestServer, value: string): boolean {
  return server.requests.some((request) => request.path.includes(value));
}

function controlPlaneUsedSince(server: TestServer, value: string, index: number): boolean {
  return server.requests.slice(index).some((request) => request.path.includes(value));
}

async function startBinaryAssetServer(path: string): Promise<{ close: () => Promise<void>; requests: string[]; url: string }> {
  const requests: string[] = [];
  const body = await readFile(path);
  const server = createServer((request, response) => {
    requests.push(request.url || "/");
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": body.byteLength
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start WebRTC asset server");
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    requests,
    url: `http://127.0.0.1:${address.port}/soe-webrtc`
  };
}

function noProxyEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost"
  };
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
