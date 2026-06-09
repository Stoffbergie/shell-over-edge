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
  status: "waiting",
  createdAt: 0,
  expiresAt: Date.UTC(2030, 0, 1)
};

const unixShells = uniqueCommands(["sh", "dash", "bash", "zsh"]);
const powerShell = findCommand(process.platform === "win32" ? ["pwsh", "powershell.exe", "powershell"] : ["pwsh"]);

test("generated shell agent is portable across common Unix environments", () => {
  const script = shellAgentScript("https://soe.test", meta);
  assert.match(script, /SESSION_ID='550e8400-e29b-41d4-a716-446655440000'/);
  assert.match(script, /pbcopy/);
  assert.match(script, /wl-copy/);
  assert.match(script, /xclip -selection clipboard/);
  assert.match(script, /xsel --clipboard --input/);
  assert.match(script, /clip\.exe/);
  assert.match(script, /base64 -d/);
  assert.match(script, /base64 -D/);
  assert.match(script, /command -v timeout/);
  assert.match(script, /api\/sessions\/\$SESSION_ID\/hello/);
  assert.match(script, /api\/sessions\/\$SESSION_ID\/next/);
  assert.match(script, /api\/sessions\/\$SESSION_ID\/result\/\$command_id\?exit=\$exit_code/);
  assert.match(script, /api\/sessions\/\$SESSION_ID\/end/);
  assert.ok(!script.includes("Authorization"));
  assert.ok(!script.includes("/api/agent/"));
  assert.ok(!script.includes("/start/"));
  assert.ok(!script.includes("?token" + "="));
  assert.ok(!script.includes("/signals"));
  assert.ok(!script.includes("/ice"));
  assert.ok(!script.includes("stun.cloudflare.com"));
  assert.ok(!script.includes("turn.cloudflare.com"));
  assert.ok(!script.includes("RTCPeerConnection"));
});

test.skipIf(unixShells.length === 0)("generated shell agent is syntax-valid across available Unix shells", async () => {
  const script = shellAgentScript("https://soe.test", meta);
  for (const shell of unixShells) await assertShellSyntax(shell, script);
});

test("generated PowerShell agent keeps Windows request fallbacks", () => {
  const script = powerShellAgentScript("https://soe.test", meta);

  assert.match(script, /\$SessionId = "550e8400-e29b-41d4-a716-446655440000"/);
  assert.match(script, /Set-Clipboard/);
  assert.match(script, /System\.Net\.WebRequest/);
  assert.match(script, /Get-ResponseHeader/);
  assert.match(script, /InnerException\.Response/);
  assert.match(script, /Start-ThreadJob/);
  assert.match(script, /Start-Job/);
  assert.match(script, /X-Command-Timeout/);
  assert.match(script, /Command timed out after \$TimeoutSeconds seconds/);
  assert.match(script, /\$StatusCode -eq 204/);
  assert.ok(!script.includes("Start-Sleep -Seconds 2"));
  assert.match(script, /api\/sessions\/\$SessionId\/hello/);
  assert.match(script, /api\/sessions\/\$SessionId\/next/);
  assert.match(script, /api\/sessions\/\$SessionId\/result\/\$\{CommandId\}\?exit=\$ExitCode/);
  assert.match(script, /api\/sessions\/\$SessionId\/end/);
  assert.ok(!script.includes("Authorization"));
  assert.ok(!script.includes("/api/agent/"));
  assert.ok(!script.includes("/start/"));
  assert.ok(!script.includes("?token" + "="));
  assert.ok(!script.includes("/signals"));
  assert.ok(!script.includes("/ice"));
  assert.ok(!script.includes("stun.cloudflare.com"));
  assert.ok(!script.includes("turn.cloudflare.com"));
  assert.ok(!script.includes("RTCPeerConnection"));
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
