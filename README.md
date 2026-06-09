# remote.stoff.dev

Terminal-to-terminal remote command runner.

## Friend Side

macOS or Linux:

```sh
curl -fsSL https://remote.stoff.dev/connect.sh | sh
```

Windows PowerShell:

```powershell
irm "https://remote.stoff.dev/connect.ps1" | iex
```

Windows Command Prompt:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://remote.stoff.dev/connect.ps1' | iex"
```

The command prints a UUID and copies it to the clipboard when possible. The friend sends you that UUID and leaves the terminal open. They will see each command and its output as it runs.

## Helper Side

Run one command at a time:

```sh
curl -sS https://remote.stoff.dev -H "x-api-key: <uuid>" --data-binary "pwd"
```

Good first test commands:

```sh
curl -sS https://remote.stoff.dev -H "x-api-key: <uuid>" --data-binary "hostname"
curl -sS https://remote.stoff.dev -H "x-api-key: <uuid>" --data-binary "whoami"
curl -sS https://remote.stoff.dev -H "x-api-key: <uuid>" --data-binary "pwd"
```

For a Windows target, PowerShell commands also work:

```sh
curl -sS https://remote.stoff.dev -H "x-api-key: <uuid>" --data-binary "Get-Location"
curl -sS https://remote.stoff.dev -H "x-api-key: <uuid>" --data-binary '$env:USERNAME'
```

Stop the session with `Ctrl+C` in the friend-side terminal.
