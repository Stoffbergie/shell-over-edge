import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { strict as assert } from "node:assert";
import { shellAgentScript } from "../../src/agent/shell";
import { powerShellAgentScript } from "../../src/agent/powershell";
import type { SessionMeta } from "../../src/domain/session";
import { findCommand } from "../helpers/commands";

const meta: SessionMeta = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  code: "abc234de",
  status: "waiting",
  createdAt: 0,
  expiresAt: Date.UTC(2030, 0, 1)
};

const unixShells = uniqueCommands(["sh", "dash", "bash", "zsh"]);
const powerShell = findCommand(process.platform === "win32" ? ["pwsh", "powershell.exe", "powershell"] : ["pwsh"]);

test("generated shell agent is relay-only and portable", () => {
  const script = shellAgentScript("https://soe.test", meta);
  assert.match(script, /SESSION_ID='abc234de'/);
  assert.match(script, /AGENT_VERSION='0\.3\.0'/);
  assert.match(script, /Session: %s \(%s\)\\nStop anytime: Ctrl\+C\\n/);
  assert.match(script, /pbcopy/);
  assert.match(script, /wl-copy/);
  assert.match(script, /xclip -selection clipboard/);
  assert.match(script, /xsel --clipboard --input/);
  assert.match(script, /clip\.exe/);
  assert.match(script, /base64 -d/);
  assert.match(script, /base64 -D/);
  assert.match(script, /command -v timeout/);
  assert.match(script, /SOE_NO_END_ON_EXIT/);
  assert.match(script, /--connect-timeout 5 --max-time 15/);
  assert.match(script, /--connect-timeout 5 --max-time 35/);
  assert.match(script, /--connect-timeout 5 --max-time 30/);
  assert.match(script, /api\/sessions\/\$SESSION_ID\/hello/);
  assert.match(script, /api\/sessions\/\$SESSION_ID\/next/);
  assert.match(script, /api\/sessions\/\$SESSION_ID\/result\/\$command_id\?exit=\$exit_code/);
  assert.match(script, /\/\$SESSION_ID\/end/);
  assert.ok(!script.includes("Shell Over Edge\\n"));
  assert.ok(!script.includes("Expires:"));
  assert.ok(!script.includes("Send command:"));
  assert.ok(!script.includes("NATIVE_"));
  assert.ok(!script.includes("WEBRTC_"));
  assert.ok(!script.includes("download_native"));
  assert.ok(!script.includes("download_webrtc"));
  assert.ok(!script.includes("probe_json"));
  assert.ok(!script.includes("config_json"));
  assert.ok(!script.includes("soe-agent"));
  assert.ok(!script.includes("soe-webrtc"));
  assert.ok(!script.includes("X-Agent-User"));
  assert.ok(!script.includes("$(whoami)"));
  assert.ok(!script.includes("--data-binary \"$(pwd)\""));
  assert.ok(!script.includes("X-Command-Type"));
  assert.ok(!script.includes("Authorization"));
  assert.ok(!script.includes("/api/agent/"));
  assert.ok(!script.includes("/start/"));
  assert.ok(!script.includes("?token" + "="));
});

test.skipIf(unixShells.length === 0)("generated shell agent is syntax-valid across available Unix shells", async () => {
  const script = shellAgentScript("https://soe.test", meta);
  for (const shell of unixShells) await assertShellSyntax(shell, script);
});

test("generated PowerShell agent is relay-only", () => {
  const script = powerShellAgentScript("https://soe.test", meta);

  assert.match(script, /\$SessionId = "abc234de"/);
  assert.match(script, /\$AgentVersion = "0\.3\.0"/);
  assert.match(script, /Write-Host "Session: \$SessionId \(\$Clipboard\)"/);
  assert.match(script, /Write-Host "Stop anytime: Ctrl\+C"/);
  assert.match(script, /Set-Clipboard/);
  assert.match(script, /System\.Net\.WebRequest/);
  assert.match(script, /\$Request\.Timeout = 35000/);
  assert.match(script, /\$Request\.ReadWriteTimeout = 35000/);
  assert.match(script, /Start-ThreadJob/);
  assert.match(script, /Start-Job/);
  assert.match(script, /X-Command-Timeout/);
  assert.match(script, /SOE_NO_END_ON_EXIT/);
  assert.match(script, /Command timed out after \$TimeoutSeconds seconds/);
  assert.match(script, /\$StatusCode -eq 204/);
  assert.match(script, /api\/sessions\/\$SessionId\/hello/);
  assert.match(script, /api\/sessions\/\$SessionId\/next/);
  assert.match(script, /api\/sessions\/\$SessionId\/result\/\$\{CommandId\}\?exit=\$ExitCode/);
  assert.match(script, /\/\$SessionId\/end/);
  assert.ok(!script.includes('Write-Host "Shell Over Edge"'));
  assert.ok(!script.includes('Write-Host "Expires:'));
  assert.ok(!script.includes('Write-Host "Send command:"'));
  assert.ok(!script.includes("Native"));
  assert.ok(!script.includes("WebRtc"));
  assert.ok(!script.includes("soe-agent"));
  assert.ok(!script.includes("soe-webrtc"));
  assert.ok(!script.includes("Get-ProbeJson"));
  assert.ok(!script.includes("Get-ConfigJson"));
  assert.ok(!script.includes("X-Agent-User"));
  assert.ok(!script.includes("[Environment]::UserName"));
  assert.ok(!script.includes("(Get-Location).Path"));
  assert.ok(!script.includes("X-Command-Type"));
  assert.ok(!script.includes("Authorization"));
  assert.ok(!script.includes("/api/agent/"));
  assert.ok(!script.includes("/start/"));
  assert.ok(!script.includes("?token" + "="));
});

test.skipIf(!powerShell)("generated PowerShell agent parses", async () => {
  await assertPowerShellParses(powerShell, powerShellAgentScript("https://soe.test", meta));
}, 30_000);

async function assertShellSyntax(sh: string, script: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "soe-shell-"));
  const file = join(dir, "agent.sh");
  await writeFile(file, script);
  const result = spawnSync(sh, ["-n", file], { encoding: "utf8" });
  await rm(dir, { force: true, recursive: true });
  assert.equal(result.status, 0, result.stderr);
}

async function assertPowerShellParses(powerShell: string, script: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "soe-pwsh-"));
  const file = join(dir, "agent.ps1");
  await writeFile(file, script);
  const result = spawnSync(powerShell, ["-NoProfile", "-Command", `[scriptblock]::Create((Get-Content -Raw ${JSON.stringify(file)})) | Out-Null`], { encoding: "utf8", timeout: 25_000 });
  await rm(dir, { force: true, recursive: true });
  assert.equal(result.error, undefined, result.error?.message || result.stderr);
  assert.equal(result.status, 0, result.stderr);
}

function uniqueCommands(names: string[]): string[] {
  return [...new Set(names.map((name) => findCommand(name)).filter(Boolean))];
}
