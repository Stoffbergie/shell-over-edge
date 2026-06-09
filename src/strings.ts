export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function safeFileName(path: string): string {
  return (path.split(/[\\/]/).pop() || "download").replace(/["\r\n]/g, "_");
}

export function quotePowerShell(value: string): string {
  return `"${value.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, "`\"")}"`;
}
