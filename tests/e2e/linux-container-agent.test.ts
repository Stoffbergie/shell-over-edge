import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
const runContainers = Boolean(docker && process.platform !== "win32" && process.env.SOE_DOCKER_E2E === "1");
const containerTest = runContainers ? test : test.skip;

const targets = [
  {
    name: "Alpine BusyBox sh",
    image: "alpine:3.20",
    command: "apk add --no-cache curl ca-certificates >/dev/null && /bin/sh /work/agent.sh"
  },
  {
    name: "Ubuntu 22.04 sh",
    image: "ubuntu:22.04",
    command: "apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null && /bin/sh /work/agent.sh"
  }
];

for (const target of targets) {
  containerTest(`generated POSIX agent runs in ${target.name}`, async () => {
    const fixture = createTestEnv();
    const server = await startAppServer(app, fixture, { listenHost: "0.0.0.0", publicHost: "host.docker.internal" });
    const dir = await mkdtemp(join(tmpdir(), "soe-linux-container-"));
    let agent: ReturnType<typeof spawn> | undefined;
    let output = () => "";
    try {
      const session = await createSession(server.baseUrl);
      await writeFile(join(dir, "agent.sh"), session.script, { mode: 0o700 });
      agent = spawn(docker, dockerArgs(target.image, dir, target.command));
      output = captureOutput(agent);

      await waitForHello(server, agent, output, 120_000);

      const result = await sendCommand(server.baseUrl, session.id, "printf container-e2e", diagnostics(output, server));
      assert.equal(result.status, 200);
      assert.equal(result.text, "container-e2e");

      await endSession(server.baseUrl, session.id);
      await waitForExit(agent, 20_000, output);
    } finally {
      if (agent && agent.exitCode === null) agent.kill();
      await rm(dir, { force: true, recursive: true });
      await server.close();
    }
  }, 180_000);
}

async function createSession(baseUrl: string): Promise<{ id: string; script: string }> {
  const response = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
  assert.equal(response.status, 200);
  const id = response.headers.get("X-Session-Id") || "";
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return { id, script: await response.text() };
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

function dockerArgs(image: string, dir: string, command: string): string[] {
  const hostArgs = process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : [];
  return [
    "run",
    "--rm",
    ...hostArgs,
    "-v",
    `${dir}:/work:ro`,
    image,
    "sh",
    "-lc",
    command
  ];
}

async function waitForHello(server: TestServer, child: ReturnType<typeof spawn>, output: () => string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (server.requests.some((request) => request.path.includes("/hello") && request.status === 200)) return;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`Container agent did not connect\n${diagnostics(output, server)()}`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number, output: () => string): Promise<void> {
  if (child.exitCode === null) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Container agent did not exit\n${output()}`)), timeoutMs);
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
