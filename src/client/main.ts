const appOrigin = window.location.origin;

setText("shell-connect", `curl -fsSL ${appOrigin}/connect.sh | sh`);
setText("windows-connect", `irm "${appOrigin}/connect.ps1" | iex`);
setText("helper-command", `curl -sS ${appOrigin} -H "x-api-key: <uuid-from-clipboard>" --data-binary "pwd"`);

document.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-copy-target]");
  if (!button) return;
  const target = document.getElementById(button.dataset.copyTarget || "");
  if (!target?.textContent) return;
  await navigator.clipboard.writeText(target.textContent);
  const label = button.textContent || "Copy";
  button.textContent = "Copied";
  window.setTimeout(() => {
    button.textContent = label;
  }, 1100);
});

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  element.textContent = value;
}
