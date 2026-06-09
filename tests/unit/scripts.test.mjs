import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { shellAgentScript, simpleShellAgentScript } from "../../.tmp/test-build/src/shell-scripts.js";
import { powerShellAgentScript, simplePowerShellAgentScript } from "../../.tmp/test-build/src/powershell-scripts.js";
import { findCommand } from "../helpers/commands.mjs";

const meta = {
  id: "sess_test",
  code: "BR-ABCDE",
  helperName: "Ada",
  helperTokenHash: "helper",
  agentTokenHash: "agent",
  status: "waiting",
  createdAt: 0,
  expiresAt: Date.UTC(2030, 0, 1)
};

test("generated shell scripts are POSIX syntax-valid and include portability fallbacks", async (t) => {
  const legacy = simpleShellAgentScript("https://soe.test");
  const modern = shellAgentScript("https://soe.test", meta, ["agent", "value"].join("-"));
  const sh = findCommand("sh");
  if (sh) {
    await assertShellSyntax(sh, legacy);
    await assertShellSyntax(sh, modern);
  } else if (process.platform !== "win32") {
    assert.fail("sh is required to validate POSIX shell scripts on this platform");
  } else {
    t.diagnostic("sh is unavailable on this Windows runner; static portability checks still ran");
  }

  assert.match(legacy, /uuidgen/);
  assert.match(legacy, /\/proc\/sys\/kernel\/random\/uuid/);
  assert.match(legacy, /python3 -c/);
  assert.match(legacy, /openssl rand/);
  assert.match(legacy, /base64 --decode/);
  assert.match(legacy, /base64 -D/);
  assert.match(legacy, /timeout "\$timeout_seconds"/);

  assert.match(modern, /Authorization: Bearer \$TOKEN/);
  assert.match(modern, /base64 --decode/);
  assert.match(modern, /base64 -D/);
  assert.match(modern, /command -v timeout/);
  assert.ok(!modern.includes("?token" + "="));
});

test("generated PowerShell scripts use header auth and curl/WebRequest fallbacks", async (t) => {
  const legacy = simplePowerShellAgentScript("https://soe.test");
  const modern = powerShellAgentScript("https://soe.test", meta, ["agent", "value"].join("-"));

  assert.match(legacy, /curl\.exe/);
  assert.match(legacy, /System\.Net\.WebRequest/);
  assert.match(legacy, /System\.Net\.Http\.HttpClient/);
  assert.match(modern, /\$Headers = @\{ Authorization = "Bearer \$Token" \}/);
  assert.match(modern, /Invoke-WebRequest/);
  assert.match(modern, /System\.Net\.WebRequest/);
  assert.match(modern, /Get-ResponseHeader/);
  assert.match(modern, /InnerException\.Response/);
  assert.match(modern, /\$StatusCode -eq 204/);
  assert.match(modern, /result\/\$\{CommandId\}\?exit=\$ExitCode/);
  assert.ok(!modern.includes("?token" + "="));

  const powerShell = findCommand(process.platform === "win32" ? ["pwsh", "powershell.exe", "powershell"] : ["pwsh"]);
  if (!powerShell) {
    t.skip("PowerShell is not installed on this runner");
    return;
  }

  await assertPowerShellParses(powerShell, legacy);
  await assertPowerShellParses(powerShell, modern);
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
