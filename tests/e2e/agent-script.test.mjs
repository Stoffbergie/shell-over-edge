import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { app } from "../../.tmp/test-build/src/app.js";
import { createTestEnv, json } from "../helpers/fake-env.mjs";
import { findCommand } from "../helpers/commands.mjs";
import { startAppServer } from "../helpers/server.mjs";

console.info = () => {};

test("generated POSIX agent script connects, runs a command, and reports output", async (t) => {
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
    const script = await fetchText(`${server.baseUrl}/start/${session.code}.sh`, session.agentToken);
    const scriptPath = join(dir, "agent.sh");
    await writeFile(scriptPath, script, { mode: 0o700 });
    agent = spawn(sh, [scriptPath], { cwd: dir });
    output = captureOutput(agent);

    await waitForEvent(server.baseUrl, session, (event) => event.type === "agent_connected", diagnostics(output, server));
    await queueCommand(server.baseUrl, session, "printf soe-posix-e2e");
    const result = await waitForEvent(server.baseUrl, session, (event) => event.type === "command_result", diagnostics(output, server));
    assert.equal(result.output, "soe-posix-e2e");
    await endSession(server.baseUrl, session);
    await waitForExit(agent, 10_000, output);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await rm(dir, { force: true, recursive: true });
    await server.close();
  }
});

test("generated PowerShell agent script connects, runs a command, and reports output", async (t) => {
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
    const session = await createSession(server.baseUrl);
    const script = await fetchText(`${server.baseUrl}/start/${session.code}.ps1`, session.agentToken);
    const scriptPath = join(dir, "agent.ps1");
    await writeFile(scriptPath, script);
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

    await waitForEvent(server.baseUrl, session, (event) => event.type === "agent_connected", diagnostics(output, server));
    await queueCommand(server.baseUrl, session, "Write-Output soe-powershell-e2e");
    const result = await waitForEvent(server.baseUrl, session, (event) => event.type === "command_result", diagnostics(output, server));
    assert.match(result.output, /soe-powershell-e2e/);
    await endSession(server.baseUrl, session);
    await waitForExit(agent, 10_000, output);
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await rm(dir, { force: true, recursive: true });
    await server.close();
  }
});

async function createSession(baseUrl) {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ helperName: "Ada" })
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function fetchText(url, token) {
  const response = await fetch(url, { headers: auth(token) });
  assert.equal(response.status, 200);
  return response.text();
}

async function queueCommand(baseUrl, session, body) {
  const response = await fetch(`${baseUrl}/api/sessions/${session.id}/commands`, {
    method: "POST",
    headers: { ...auth(session.helperToken), "Content-Type": "application/json" },
    body: JSON.stringify({ body, timeoutSeconds: 10 })
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function endSession(baseUrl, session) {
  const response = await fetch(`${baseUrl}/api/sessions/${session.id}/end`, {
    method: "POST",
    headers: auth(session.helperToken)
  });
  assert.equal(response.status, 200);
}

async function waitForEvent(baseUrl, session, predicate, details = () => "") {
  const start = Date.now();
  let after = "";
  const seen = [];
  while (Date.now() - start < 15_000) {
    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/events?after=${encodeURIComponent(after)}`, {
      headers: auth(session.helperToken)
    });
    assert.equal(response.status, 200);
    const payload = await json(response);
    after = payload.cursor || after;
    seen.push(...payload.events.map((event) => ({ id: event.id, type: event.type, commandId: event.commandId, exitCode: event.exitCode })));
    const match = payload.events.find(predicate);
    if (match) return match;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for event\nrecent events:\n${JSON.stringify(seen.slice(-30))}\n${details()}`);
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
    "agent requests:",
    JSON.stringify(server.requests.filter((request) => request.path.includes("/api/agent/")).slice(-30)),
    "command requests:",
    JSON.stringify(server.requests.filter((request) => request.path.includes("/commands")).slice(-10)),
    "recent requests:",
    JSON.stringify(server.requests.slice(-40))
  ].join("\n");
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function powerShellArgs(command, scriptPath) {
  const base = ["-NoProfile"];
  if (/powershell(?:\.exe)?$/i.test(command)) base.push("-ExecutionPolicy", "Bypass");
  return [...base, "-File", scriptPath];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
