import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { app } from "../../.tmp/test-build/src/app.js";
import { createTestEnv } from "../helpers/fake-env.mjs";
import { findCommand } from "../helpers/commands.mjs";
import { startAppServer } from "../helpers/server.mjs";

console.info = () => {};

test("generated POSIX agent script connects, runs a command, and streams text back through send", async (t) => {
  const sh = findCommand("sh");
  const curl = findCommand("curl");
  if (!sh || !curl) {
    t.skip("sh and curl are required for POSIX agent e2e");
    return;
  }

  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-posix-e2e-"));
  let agent;
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
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await rm(dir, { force: true, recursive: true });
    await server.close();
  }
});

test("generated PowerShell agent script connects, runs a command, and streams text back through send", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell agent e2e runs on Windows; POSIX agent e2e covers Unix hosts");
    return;
  }

  const powerShell = findCommand(process.platform === "win32" ? ["pwsh", "powershell.exe", "powershell"] : ["pwsh"]);
  if (!powerShell) {
    t.skip("PowerShell is required for PowerShell agent e2e");
    return;
  }

  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  const dir = await mkdtemp(join(tmpdir(), "soe-powershell-e2e-"));
  let agent;
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
    await rm(dir, { force: true, recursive: true });
    await server.close();
  }
});

async function createSession(baseUrl, path = "/api/sessions") {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST" });
  assert.equal(response.status, 200);
  const id = response.headers.get("X-Session-Id");
  assert.match(id || "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return { id, script: await response.text() };
}

async function sendCommand(baseUrl, id, body, details = () => "") {
  const response = await fetch(`${baseUrl}/api/sessions/${id}/send`, {
    method: "POST",
    body: JSON.stringify({ body, timeoutSeconds: 10 })
  });
  const result = { status: response.status, text: await response.text() };
  assert.notEqual(result.status, 504, `${result.text}\n${details()}`);
  return result;
}

async function endSession(baseUrl, id) {
  const response = await fetch(`${baseUrl}/api/sessions/${id}/end`, { method: "POST" });
  assert.equal(response.status, 200);
}

async function waitForExit(child, timeoutMs, output) {
  if (child.exitCode === null) {
    await new Promise((resolve, reject) => {
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

function captureOutput(child) {
  const chunks = [];
  child.stdout?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  return () => Buffer.concat(chunks).toString("utf8");
}

function diagnostics(output, server) {
  return () => [
    "agent output:",
    output(),
    "session requests:",
    JSON.stringify(server.requests.filter((request) => request.path.includes("/api/sessions/")).slice(-40)),
    "recent requests:",
    JSON.stringify(server.requests.slice(-50))
  ].join("\n");
}

function powerShellArgs(command, scriptPath) {
  const base = ["-NoProfile"];
  if (/powershell(?:\.exe)?$/i.test(command)) base.push("-ExecutionPolicy", "Bypass");
  return [...base, "-File", scriptPath];
}
