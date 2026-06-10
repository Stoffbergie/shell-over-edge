import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { strict as assert } from "node:assert";
import { powerShellBootstrapScript, shellBootstrapScript } from "../../src/agent/bootstrap";
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

test("generated shell agent is portable across common Unix environments", () => {
  const script = shellAgentScript("https://soe.test", meta);
  assert.match(script, /SESSION_ID='abc234de'/);
  assert.match(script, /AGENT_VERSION='0\.2\.0'/);
  assert.match(script, /NATIVE_BASE_URL=/);
  assert.match(script, /Session: %s \(%s\)\\nStop anytime: Ctrl\+C\\n/);
  assert.ok(!script.includes("Shell Over Edge\\n"));
  assert.ok(!script.includes("Expires:"));
  assert.ok(!script.includes("Send command:"));
  assert.match(script, /pbcopy/);
  assert.match(script, /wl-copy/);
  assert.match(script, /xclip -selection clipboard/);
  assert.match(script, /xsel --clipboard --input/);
  assert.match(script, /clip\.exe/);
  assert.match(script, /base64 -d/);
  assert.match(script, /base64 -D/);
  assert.match(script, /command -v timeout/);
  assert.match(script, /SOE_NO_END_ON_EXIT/);
  assert.match(script, /probe_json\(\)/);
  assert.match(script, /config_json\(\)/);
  assert.match(script, /download_native\(\)/);
  assert.match(script, /X-Command-Type/);
  assert.match(script, /exec "\$NATIVE_FILE" --base-url "\$BASE_URL" --session "\$SESSION_ID"/);
  assert.match(script, /--connect-timeout 5 --max-time 15/);
  assert.match(script, /--connect-timeout 5 --max-time 35/);
  assert.match(script, /--connect-timeout 5 --max-time 30/);
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

  assert.match(script, /\$SessionId = "abc234de"/);
  assert.match(script, /\$AgentVersion = "0\.2\.0"/);
  assert.match(script, /\$NativeBaseUrl =/);
  assert.match(script, /Write-Host "Session: \$SessionId \(\$Clipboard\)"/);
  assert.match(script, /Write-Host "Stop anytime: Ctrl\+C"/);
  assert.ok(!script.includes('Write-Host "Shell Over Edge"'));
  assert.ok(!script.includes('Write-Host "Expires:'));
  assert.ok(!script.includes('Write-Host "Send command:"'));
  assert.match(script, /Set-Clipboard/);
  assert.match(script, /System\.Net\.WebRequest/);
  assert.match(script, /\$Request\.Timeout = 35000/);
  assert.match(script, /\$Request\.ReadWriteTimeout = 35000/);
  assert.match(script, /Get-ResponseHeader/);
  assert.match(script, /InnerException\.Response/);
  assert.match(script, /Start-ThreadJob/);
  assert.match(script, /Start-Job/);
  assert.match(script, /X-Command-Timeout/);
  assert.match(script, /X-Command-Type/);
  assert.match(script, /SOE_NO_END_ON_EXIT/);
  assert.match(script, /Get-ProbeJson/);
  assert.match(script, /Get-ConfigJson/);
  assert.match(script, /Start-NativeDownload/);
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

test.skipIf(unixShells.length === 0)("generated POSIX bootstrap is syntax-valid across available Unix shells", async () => {
  const script = shellBootstrapScript("https://soe.test");
  assert.match(script, /SOE_NATIVE_BASE_URL/);
  assert.match(script, /SOE_AUTO_UPGRADE/);
  assert.match(script, /SOE_WARM_NATIVE/);
  assert.ok(script.includes('if [ "${SOE_AUTO_UPGRADE:-}" = "1" ] || [ "${SOE_WARM_NATIVE:-}" = "1" ] || [ -n "${SOE_NATIVE_URL:-}" ]; then'));
  assert.match(script, /--connect-timeout 5 --max-time 20/);
  assert.match(script, /SOE_NO_END_ON_EXIT=1 sh "\$AGENT_FILE"/);
  assert.match(script, /exec "\$NATIVE_FILE" --base-url "\$BASE_URL" --session "\$SESSION_ID"/);
  for (const shell of unixShells) await assertShellSyntax(shell, script);
});

test.skipIf(!powerShell)("generated PowerShell bootstrap parses", async () => {
  const script = powerShellBootstrapScript("https://soe.test");
  assert.match(script, /SOE_NATIVE_BASE_URL/);
  assert.match(script, /SOE_AUTO_UPGRADE/);
  assert.match(script, /SOE_WARM_NATIVE/);
  assert.ok(script.includes('if ($env:SOE_AUTO_UPGRADE -eq "1" -or $env:SOE_WARM_NATIVE -eq "1" -or $env:SOE_NATIVE_URL)'));
  assert.match(script, /-TimeoutSec 20/);
  assert.match(script, /\$env:SOE_NO_END_ON_EXIT = "1"/);
  assert.match(script, /--base-url \$BaseUrl --session \$SessionId/);
  await assertPowerShellParses(powerShell, script);
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
