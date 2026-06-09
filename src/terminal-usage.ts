export function terminalUsage(baseUrl: string): string {
  return `Shell Over Edge

Open a macOS/Linux session:
curl -sS -X POST ${baseUrl}/api/sessions | sh

Open a Windows session:
irm -Method Post ${baseUrl}/api/sessions.ps1 | iex

Send a command:
curl -sS -X POST ${baseUrl}/api/sessions/<uuid>/send --data 'pwd'

Send a command with options:
curl -sS -X POST ${baseUrl}/api/sessions/<uuid>/send \\
  --data '{"body":"pwd"}'
`;
}
