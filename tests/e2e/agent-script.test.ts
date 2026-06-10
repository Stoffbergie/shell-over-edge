import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { test } from "vitest";
import { strict as assert } from "node:assert";
import { app } from "../../src/worker/app";
import { createTestEnv } from "../helpers/fake-env";
import { findCommand } from "../helpers/commands";
import { startAppServer, type TestServer } from "../helpers/server";

console.info = () => {};

const sh = findCommand("sh");
const curl = findCommand("curl");
const powerShell = findCommand(process.platform === "win32" ? ["pwsh", "powershell.exe", "powershell"] : ["pwsh"]);

test.skipIf(!sh || !curl)("generated POSIX agent connects, runs a command, and returns text through send", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-posix-e2e-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let output = () => "";
  try {
    const session = await createSession(server.baseUrl);
    const scriptPath = join(dir, "agent.sh");
    await writeFile(scriptPath, session.script, { mode: 0o700 });
    agent = spawn(sh, [scriptPath], { cwd: dir });
    output = captureOutput(agent);

    const result = await sendCommand(server.baseUrl, session.id, "printf soe-posix-e2e", diagnostics(output, server));
    assert.equal(result.status, 200);
    assert.equal(result.text, "soe-posix-e2e");

    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, output);
    assertCompactAgentOutput(output(), session.id);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await removeDir(dir);
    await server.close();
  }
});

test.skipIf(!sh || !curl)("POSIX bootstrap starts the relay agent only", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-posix-bootstrap-e2e-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let output = () => "";
  try {
    const script = await fetchText(`${server.baseUrl}/a`);
    assert.ok(!script.includes("SOE_NATIVE"));
    assert.ok(!script.includes("SOE_AUTO_UPGRADE"));
    assert.ok(!script.includes("SOE_WARM_NATIVE"));
    const scriptPath = join(dir, "bootstrap.sh");
    await writeFile(scriptPath, script, { mode: 0o700 });
    agent = spawn(sh, [scriptPath], {
      cwd: dir,
      env: {
        ...process.env,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost"
      }
    });
    output = captureOutput(agent);

    const id = await waitForSessionId(output, 10_000);
    const result = await sendCommand(server.baseUrl, id, "printf soe-bootstrap-e2e", diagnostics(output, server));
    assert.equal(result.status, 200);
    assert.equal(result.text, "soe-bootstrap-e2e");
    assert.equal(server.requests.some((request) => request.path.includes("native") || request.path.includes("webrtc")), false);

    await endSession(server.baseUrl, id);
    await waitForExit(agent, 10_000, output);
    assertCompactAgentOutput(output(), id);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await removeDir(dir);
    await server.close();
  }
});

test.skipIf(!sh || !curl)("generated POSIX agent drains parallel relay sends without result mixups", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-posix-parallel-e2e-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let output = () => "";
  try {
    const session = await createSession(server.baseUrl);
    const scriptPath = join(dir, "agent.sh");
    await writeFile(scriptPath, session.script, { mode: 0o700 });
    agent = spawn(sh, [scriptPath], { cwd: dir });
    output = captureOutput(agent);

    const count = 8;
    const results = await Promise.all(Array.from({ length: count }, (_, index) => {
      const expected = `soe-posix-parallel-${index}`;
      return sendCommand(server.baseUrl, session.id, `printf ${expected}`, diagnostics(output, server))
        .then((result) => ({ expected, result }));
    }));

    for (const item of results) {
      assert.equal(item.result.status, 200);
      assert.equal(item.result.text, item.expected);
    }

    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, output);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await removeDir(dir);
    await server.close();
  }
});

test.skipIf(process.platform === "win32" || !sh || !curl)("generated POSIX agent enforces command timeout without timeout binary", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-posix-no-timeout-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let output = () => "";
  try {
    const bin = await pathWithoutTimeout(dir);
    const session = await createSession(server.baseUrl);
    const scriptPath = join(dir, "agent.sh");
    await writeFile(scriptPath, session.script, { mode: 0o700 });
    agent = spawn(sh, [scriptPath], { cwd: dir, env: { ...process.env, PATH: bin } });
    output = captureOutput(agent);

    const startedAt = performance.now();
    const timedOut = await sendCommand(server.baseUrl, session.id, "sleep 5; printf too-late", diagnostics(output, server), 1);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(timedOut.status, 500);
    assert.ok(elapsedMs < 4000, `fallback timeout took ${elapsedMs}ms\n${diagnostics(output, server)()}`);

    const recovered = await sendCommand(server.baseUrl, session.id, "printf recovered", diagnostics(output, server));
    assert.equal(recovered.status, 200);
    assert.equal(recovered.text, "recovered");

    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, output);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await removeDir(dir);
    await server.close();
  }
});

test.skipIf(process.platform !== "win32" || !powerShell)("generated PowerShell agent connects, runs a command, and returns text through send", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-powershell-e2e-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let output = () => "";
  try {
    const session = await createSession(server.baseUrl, "/api/sessions.ps1");
    const scriptPath = join(dir, "agent.ps1");
    await writeFile(scriptPath, session.script);
    await mkdir(join(dir, "work"));
    agent = spawn(powerShell, powerShellArgs(powerShell, scriptPath), {
      cwd: join(dir, "work"),
      env: {
        ...process.env,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost"
      }
    });
    output = captureOutput(agent);

    const result = await sendCommand(server.baseUrl, session.id, "Write-Output soe-powershell-e2e", diagnostics(output, server));
    assert.equal(result.status, 200);
    assert.match(result.text, /soe-powershell-e2e/);

    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, output);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await removeDir(dir);
    await server.close();
  }
});

test.skipIf(process.platform !== "win32" || !powerShell)("generated PowerShell agent enforces command timeout", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-powershell-timeout-e2e-"));
  let agent: ReturnType<typeof spawn> | undefined;
  let output = () => "";
  try {
    const session = await createSession(server.baseUrl, "/api/sessions.ps1");
    const scriptPath = join(dir, "agent.ps1");
    await writeFile(scriptPath, session.script);
    await mkdir(join(dir, "work"));
    agent = spawn(powerShell, powerShellArgs(powerShell, scriptPath), {
      cwd: join(dir, "work"),
      env: {
        ...process.env,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost"
      }
    });
    output = captureOutput(agent);

    const startedAt = performance.now();
    const timedOut = await sendCommand(server.baseUrl, session.id, "Start-Sleep -Seconds 10; Write-Output too-late", diagnostics(output, server), 3);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(timedOut.status, 500);
    assert.match(timedOut.text, /timed out/i);
    assert.ok(elapsedMs < 8000, `PowerShell timeout took ${elapsedMs}ms\n${diagnostics(output, server)()}`);

    const recovered = await sendCommand(server.baseUrl, session.id, "Write-Output recovered", diagnostics(output, server));
    assert.equal(recovered.status, 200);
    assert.match(recovered.text, /recovered/);

    await endSession(server.baseUrl, session.id);
    await waitForExit(agent, 10_000, output);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await removeDir(dir);
    await server.close();
  }
});

async function createSession(baseUrl: string, path = "/api/sessions"): Promise<{ id: string; script: string }> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST" });
  assert.equal(response.status, 200);
  const id = response.headers.get("X-Session-Id") || "";
  assert.match(id, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  return { id, script: await response.text() };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.text();
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

async function endSession(baseUrl: string, id: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/sessions/${id}/end`, { method: "POST" });
  assert.equal(response.status, 200);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number, output: () => string): Promise<void> {
  if (child.exitCode === null) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Agent did not exit\n${output()}`)), timeoutMs);
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

async function waitForSessionId(output: () => string, timeoutMs: number): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = output().match(/Session: ([23456789abcdefghjkmnpqrstuvwxyz]{8})/);
    if (match) return match[1];
    await sleep(50);
  }
  throw new Error(`Bootstrap did not print a session id\n${output()}`);
}

async function removeDir(dir: string): Promise<void> {
  await rm(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
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

function assertCompactAgentOutput(output: string, sessionId: string): void {
  assert.match(output, new RegExp(`Session: ${sessionId} \\(`));
  assert.match(output, /Stop anytime: Ctrl\+C/);
  assert.ok(!output.includes("Shell Over Edge"));
  assert.ok(!output.includes("Expires:"));
  assert.ok(!output.includes("Send command:"));
  assert.ok(!output.includes("Session ended"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function powerShellArgs(command: string, scriptPath: string): string[] {
  const base = ["-NoProfile"];
  if (/powershell(?:\.exe)?$/i.test(command)) base.push("-ExecutionPolicy", "Bypass");
  return [...base, "-File", scriptPath];
}

async function pathWithoutTimeout(dir: string): Promise<string> {
  const bin = join(dir, "bin");
  await mkdir(bin);
  for (const command of ["awk", "cat", "curl", "kill", "mktemp", "rm", "sh", "sleep", "uname", "whoami"]) {
    const path = findCommand(command);
    if (path) await symlink(path, join(bin, command));
  }
  return bin;
}
