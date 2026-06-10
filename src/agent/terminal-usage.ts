export function terminalUsage(baseUrl: string): string {
  return `Shell Over Edge

Open a macOS/Linux session:
curl -sS ${baseUrl}/a | sh

Open a Windows session:
irm ${baseUrl}/a.ps1 | iex

Send a command:
curl -sS -X POST ${baseUrl}/api/sessions/<code>/send --data 'pwd'

Probe the machine:
curl -sS ${baseUrl}/api/sessions/<code>/probe

Upgrade transport:
curl -sS -X POST ${baseUrl}/api/sessions/<code>/config --data 'native'

Send a command with options:
curl -sS -X POST ${baseUrl}/api/sessions/<code>/send \\
  --data '{"body":"pwd"}'
`;
}
