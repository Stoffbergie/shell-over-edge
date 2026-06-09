export function terminalUsage(baseUrl: string): string {
  return `Shell Over Edge

Create a session:
curl -sS -X POST ${baseUrl}/api/sessions \\
  -H "Content-Type: application/json" \\
  --data '{"helperName":"Dirk"}'

Run shellCommand or windowsCommand from the response on the remote machine.

Queue a command:
curl -sS -X POST ${baseUrl}/api/sessions/<session-id>/commands \\
  -H "Authorization: Bearer <helper-token>" \\
  -H "Content-Type: application/json" \\
  --data '{"body":"pwd"}'
`;
}
