import { rm, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const buildDir = ".tmp/test-build";

await rm(buildDir, { force: true, recursive: true });
run(process.execPath, [join("node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.test.json"]);
await fixImports(join(buildDir, "src"));
run(process.execPath, ["--test", ...await testFiles("tests")]);

async function fixImports(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await fixImports(path);
      continue;
    }
    if (!entry.isFile() || !path.endsWith(".js")) continue;
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace(/from "(\.[^"]+?)"/g, (_match, specifier) => {
      return specifier.endsWith(".js") ? `from "${specifier}"` : `from "${specifier}.js"`;
    }));
  }
}

async function testFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await testFiles(path));
      continue;
    }
    if (entry.isFile() && path.endsWith(".test.mjs")) files.push(path);
  }
  return files.sort();
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
