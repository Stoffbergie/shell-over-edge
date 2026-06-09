import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { shellAgentScript } from "../../.tmp/test-build/src/shell-scripts.js";
import { powerShellAgentScript } from "../../.tmp/test-build/src/powershell-scripts.js";
import { findCommand } from "../helpers/commands.mjs";

const meta = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  status: "waiting",
  createdAt: 0,
  expiresAt: Date.UTC(2030, 0, 1)
};

test("generated shell agent is POSIX syntax-valid and portable across common Unix environments", async (t) => {
  const script = shellAgentScript("https://soe.test", meta);
  const sh = findCommand("sh");
  if (sh) {
    await assertShellSyntax(sh, script);
  } else if (process.platform !== "win32") {
    assert.fail("sh is required to validate POSIX shell scripts on this platform");
  } else {
    t.diagnostic("sh is unavailable on this Windows runner; static portability checks still ran");
  }

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
});

test("generated PowerShell agent parses and keeps Windows request fallbacks", async (t) => {
  const script = powerShellAgentScript("https://soe.test", meta);

  assert.match(script, /\$SessionId = "550e8400-e29b-41d4-a716-446655440000"/);
  assert.match(script, /Set-Clipboard/);
  assert.match(script, /System\.Net\.WebRequest/);
  assert.match(script, /Get-ResponseHeader/);
  assert.match(script, /InnerException\.Response/);
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

  const powerShell = findCommand(process.platform === "win32" ? ["pwsh", "powershell.exe", "powershell"] : ["pwsh"]);
  if (!powerShell) {
    t.skip("PowerShell is not installed on this runner");
    return;
  }

  await assertPowerShellParses(powerShell, script);
});

async function assertShellSyntax(sh, script) {
  const dir = await mkdtemp(join(tmpdir(), "soe-shell-"));
  const file = join(dir, "agent.sh");
  await writeFile(file, script);
  const result = spawnSync(sh, ["-n", file], { encoding: "utf8" });
  await rm(dir, { force: true, recursive: true });
  assert.equal(result.status, 0, result.stderr);
}

async function assertPowerShellParses(powerShell, script) {
  const dir = await mkdtemp(join(tmpdir(), "soe-pwsh-"));
  const file = join(dir, "agent.ps1");
  await writeFile(file, script);
  const result = spawnSync(powerShell, ["-NoProfile", "-Command", `[scriptblock]::Create((Get-Content -Raw ${JSON.stringify(file)})) | Out-Null`], { encoding: "utf8" });
  await rm(dir, { force: true, recursive: true });
  assert.equal(result.status, 0, result.stderr);
}
