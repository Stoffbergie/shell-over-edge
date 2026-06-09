import { existsSync } from "node:fs";
import { mkdtemp, rm, copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "vitest";
import { strict as assert } from "node:assert";
import { app } from "../../src/worker/app";
import { createTestEnv } from "../helpers/fake-env";
import { findCommand } from "../helpers/commands";
import { startAppServer, type TestServer } from "../helpers/server";

console.info = () => {};

const docker = findCommand("docker");
const linuxAgent = process.env.SOE_AGENT_LINUX_BIN || join(process.cwd(), "zig-out", "bin", "soe-agent");
const runContainers = Boolean(docker && process.platform !== "win32" && process.env.SOE_DOCKER_E2E === "1" && existsSync(linuxAgent));
const containerTest = runContainers ? test : test.skip;

const targets = [
  {
    name: "Alpine Linux",
    image: "alpine:3.20"
  },
  {
    name: "Debian 12",
    image: "debian:12-slim"
  },
  {
    name: "Ubuntu 22.04",
    image: "ubuntu:22.04"
  }
];

for (const target of targets) {
  containerTest(`native agent runs in ${target.name}`, async () => {
    const fixture = createTestEnv();
    const server = await startAppServer(app, fixture, { listenHost: "0.0.0.0", publicHost: "host.docker.internal" });
    const dir = await mkdtemp(join(tmpdir(), "soe-native-linux-container-"));
    let agent: ReturnType<typeof spawn> | undefined;
    let output = () => "";
    try {
      const session = await createSession(server.baseUrl);
      await copyFile(linuxAgent, join(dir, "soe-agent"));
      await chmod(join(dir, "soe-agent"), 0o755);
      agent = spawn(docker, dockerArgs(target.image, dir, session.id, server.publicBaseUrl));
      output = captureOutput(agent);

      await waitForHello(server, agent, output, 30_000);

      const result = await sendCommand(server.baseUrl, session.id, "printf native-container-e2e", diagnostics(output, server));
      assert.equal(result.status, 200);
      assert.equal(result.text, "native-container-e2e");

      await endSession(server.baseUrl, session.id);
      await waitForExit(agent, 20_000, output);
    } finally {
      if (agent && agent.exitCode === null) agent.kill();
      await rm(dir, { force: true, recursive: true });
      await server.close();
    }
  }, 90_000);
}

async function createSession(baseUrl: string): Promise<{ id: string }> {
  const response = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
  assert.equal(response.status, 200);
  const id = response.headers.get("X-Session-Id") || "";
  assert.match(id, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  await response.text();
  return { id };
}

async function sendCommand(baseUrl: string, id: string, body: string, details = () => ""): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}/api/sessions/${id}/send`, {
    method: "POST",
    body: JSON.stringify({ body, timeoutSeconds: 10 })
  });
  const result = { status: response.status, text: await response.text() };
  assert.notEqual(result.status, 504, `${result.text}\n${details()}`);
  return result;
}

async function endSession(baseUrl: string, id: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/sessions/${id}/end`, { method: "POST" });
  assert.equal(response.status, 200);
}

function dockerArgs(image: string, dir: string, sessionId: string, baseUrl: string): string[] {
  const hostArgs = process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : [];
  return [
    "run",
    "--rm",
    ...hostArgs,
    "-v",
    `${dir}:/work:ro`,
    image,
    "/work/soe-agent",
    "--base-url",
    baseUrl,
    "--session",
    sessionId
  ];
}

async function waitForHello(server: TestServer, child: ReturnType<typeof spawn>, output: () => string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (server.requests.some((request) => request.path.includes("/hello") && request.status === 200)) return;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`Native container agent did not connect\n${diagnostics(output, server)()}`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number, output: () => string): Promise<void> {
  if (child.exitCode === null) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Native container agent did not exit\n${output()}`)), timeoutMs);
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
    "linux agent:",
    linuxAgent,
    "agent output:",
    output(),
    "session requests:",
    JSON.stringify(server.requests.filter((request) => request.path.includes("/api/sessions/")).slice(-40)),
    "recent requests:",
    JSON.stringify(server.requests.slice(-50))
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
