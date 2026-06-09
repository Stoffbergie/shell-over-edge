import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([".git", ".tmp", ".wrangler", "node_modules"]);
const banned = [
  "remote" + ".stoff.dev",
  "remote" + "-stoff-dev",
  "remote" + "_stoff",
  "Buddy Dev" + " Support",
  "[rem" + "ote]",
  "?token" + "="
];

const requiredFiles = [
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/labeler.yml",
  ".github/workflows/release.yml",
  "LICENSE",
  "scripts/repo-audit.mjs",
  "scripts/smoke-prod.mjs"
];

const textFiles = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) await walk(join(dir, entry.name));
      continue;
    }
    if (entry.isFile()) textFiles.push(join(dir, entry.name));
  }
}

async function readText(path) {
  return readFile(path, "utf8");
}

async function main() {
  await walk(root);
  const failures = [];

  for (const file of requiredFiles) {
    try {
      await readText(join(root, file));
    } catch {
      failures.push(`Missing ${file}`);
    }
  }

  for (const file of textFiles) {
    const rel = relative(root, file);
    if (rel === "pnpm-lock.yaml") continue;
    const text = await readText(file).catch(() => "");
    for (const value of banned) {
      if (text.includes(value)) failures.push(`${rel} contains ${value}`);
    }
  }

  const pkg = JSON.parse(await readText(join(root, "package.json")));
  if (pkg.name !== "soe") failures.push("package.json name must be soe");
  if (pkg.private !== false) failures.push("package.json private must be false");
  if (pkg.description !== "Temporary shell and file access through Cloudflare Workers.") failures.push("package.json description is wrong");
  if (pkg.homepage !== "https://soe.stoff.dev") failures.push("package.json homepage must be https://soe.stoff.dev");
  if (pkg.repository?.url !== "https://github.com/Stoffberg/shell-over-edge.git") failures.push("package.json repository URL is wrong");

  const wrangler = await readText(join(root, "wrangler.toml"));
  for (const value of ['name = "soe"', 'BASE_URL = "https://soe.stoff.dev"', 'pattern = "soe.stoff.dev"', 'bucket_name = "soe-mailbox"']) {
    if (!wrangler.includes(value)) failures.push(`wrangler.toml missing ${value}`);
  }

  const readme = await readText(join(root, "README.md"));
  if (!readme.includes("# Shell Over Edge")) failures.push("README must use the full product name");
  if (!readme.includes("Temporary shell and file access through Cloudflare Workers.")) failures.push("README one-liner is wrong");

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log("repo audit passed");
}

await main();
