export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function quotePowerShell(value: string): string {
  return `"${value.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, "`\"")}"`;
}
