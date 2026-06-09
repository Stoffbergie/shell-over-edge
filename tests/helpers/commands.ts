import { spawnSync } from "node:child_process";

export function findCommand(names: string | string[]): string {
  for (const name of Array.isArray(names) ? names : [names]) {
    if (process.platform === "win32") {
      const result = spawnSync("where.exe", [name], { encoding: "utf8" });
      if (!result.error && result.status === 0) return name;
    } else {
      const result = spawnSync("sh", ["-c", `command -v ${quoteShell(name)}`], { encoding: "utf8" });
      if (!result.error && result.status === 0) return result.stdout.trim().split(/\r?\n/, 1)[0] || name;
    }
  }
  return "";
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
