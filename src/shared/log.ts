export function logInfo(event: string, fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, ...fields, ts: new Date().toISOString() }));
}
