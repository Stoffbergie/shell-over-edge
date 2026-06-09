type CreateSessionResponse = {
  id: string;
  code: string;
  helperToken: string;
  helperName: string;
  status: string;
  expiresAt: number;
  shellCommand: string;
  windowsCommand: string;
};

type StoredSession = CreateSessionResponse;

type EventRecord = {
  id: string;
  ts: number;
  type: string;
  message: string;
  output?: string;
  status?: string;
  exitCode?: number;
  downloadId?: string;
  path?: string;
  size?: number;
};

const createPanel = mustElement<HTMLElement>("create-panel");
const sessionPanel = mustElement<HTMLElement>("session-panel");
const createForm = mustElement<HTMLFormElement>("create-form");
const commandForm = mustElement<HTMLFormElement>("command-form");
const uploadForm = mustElement<HTMLFormElement>("upload-form");
const downloadForm = mustElement<HTMLFormElement>("download-form");
const clearOutputButton = mustElement<HTMLButtonElement>("clear-output");
const endSessionButton = mustElement<HTMLButtonElement>("end-session");
const output = mustElement<HTMLElement>("output");
const sessionCode = mustElement<HTMLElement>("session-code");
const sessionStatus = mustElement<HTMLElement>("session-status");
const shellCommand = mustElement<HTMLElement>("shell-command");
const windowsCommand = mustElement<HTMLElement>("windows-command");
const commandState = mustElement<HTMLElement>("command-state");
const fileState = mustElement<HTMLElement>("file-state");

let currentSession: StoredSession | null = readSession();
let eventCursor = "";
let pollTimer: number | undefined;

if (currentSession) {
  showSession(currentSession);
}

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const helperName = mustElement<HTMLInputElement>("helper-name").value.trim() || "Dirk";
  setSubmitting(createForm, true);
  try {
    const session = await request<CreateSessionResponse>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ helperName }),
      headers: { "Content-Type": "application/json" }
    });
    currentSession = session;
    localStorage.setItem("remote.stoff.dev.session", JSON.stringify(session));
    eventCursor = "";
    output.replaceChildren();
    showSession(session);
  } catch (error) {
    appendEvent({
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: "error",
      message: errorMessage(error)
    });
  } finally {
    setSubmitting(createForm, false);
  }
});

commandForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentSession) return;
  const body = mustElement<HTMLTextAreaElement>("command-body").value.trim();
  const cwd = mustElement<HTMLInputElement>("command-cwd").value.trim();
  const timeoutSeconds = Number(mustElement<HTMLInputElement>("command-timeout").value || "900");
  if (!body) return;
  commandState.textContent = "queued";
  setSubmitting(commandForm, true);
  try {
    await request(`/api/sessions/${currentSession.id}/commands`, {
      method: "POST",
      headers: authHeaders(currentSession, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body, cwd, timeoutSeconds })
    });
    commandState.textContent = "sent";
  } catch (error) {
    commandState.textContent = errorMessage(error);
  } finally {
    setSubmitting(commandForm, false);
  }
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentSession) return;
  const fileInput = mustElement<HTMLInputElement>("upload-file");
  const file = fileInput.files?.[0];
  if (!file) return;
  const path = mustElement<HTMLInputElement>("upload-path").value.trim() || file.name;
  const formData = new FormData();
  formData.set("path", path);
  formData.set("file", file);
  fileState.textContent = "uploading";
  setSubmitting(uploadForm, true);
  try {
    await request(`/api/sessions/${currentSession.id}/upload`, {
      method: "POST",
      headers: authHeaders(currentSession),
      body: formData
    });
    fileState.textContent = "write queued";
    fileInput.value = "";
  } catch (error) {
    fileState.textContent = errorMessage(error);
  } finally {
    setSubmitting(uploadForm, false);
  }
});

downloadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentSession) return;
  const path = mustElement<HTMLInputElement>("download-path").value.trim();
  if (!path) return;
  fileState.textContent = "read queued";
  setSubmitting(downloadForm, true);
  try {
    await request(`/api/sessions/${currentSession.id}/download`, {
      method: "POST",
      headers: authHeaders(currentSession, { "Content-Type": "application/json" }),
      body: JSON.stringify({ path })
    });
  } catch (error) {
    fileState.textContent = errorMessage(error);
  } finally {
    setSubmitting(downloadForm, false);
  }
});

endSessionButton.addEventListener("click", async () => {
  if (!currentSession) return;
  endSessionButton.disabled = true;
  try {
    await request(`/api/sessions/${currentSession.id}/end`, {
      method: "POST",
      headers: authHeaders(currentSession)
    });
    sessionStatus.textContent = "ended";
    localStorage.removeItem("remote.stoff.dev.session");
    currentSession = null;
    if (pollTimer) window.clearInterval(pollTimer);
  } catch (error) {
    appendEvent({
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: "error",
      message: errorMessage(error)
    });
  } finally {
    endSessionButton.disabled = false;
  }
});

clearOutputButton.addEventListener("click", () => output.replaceChildren());

document.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-copy-target]");
  if (!button) return;
  const target = mustElement<HTMLElement>(button.dataset.copyTarget || "");
  await navigator.clipboard.writeText(target.textContent || "");
  const label = button.textContent || "Copy";
  button.textContent = "Copied";
  window.setTimeout(() => {
    button.textContent = label;
  }, 1100);
});

output.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-download-id]");
  if (!button || !currentSession) return;
  const downloadId = button.dataset.downloadId || "";
  const path = button.dataset.path || "download";
  button.disabled = true;
  try {
    const response = await fetch(`/api/sessions/${currentSession.id}/downloads/${downloadId}`, {
      headers: authHeaders(currentSession)
    });
    if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = path.split(/[\\/]/).pop() || "download";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    appendEvent({
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: "error",
      message: errorMessage(error)
    });
  } finally {
    button.disabled = false;
  }
});

function showSession(session: StoredSession) {
  createPanel.classList.add("hidden");
  sessionPanel.classList.remove("hidden");
  sessionCode.textContent = session.code;
  sessionStatus.textContent = session.status;
  shellCommand.textContent = session.shellCommand;
  windowsCommand.textContent = session.windowsCommand;
  startPolling();
}

function startPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollEvents();
  pollTimer = window.setInterval(pollEvents, 1800);
}

async function pollEvents() {
  if (!currentSession) return;
  const url = new URL(`/api/sessions/${currentSession.id}/events`, window.location.origin);
  if (eventCursor) url.searchParams.set("after", eventCursor);
  try {
    const data = await request<{ events: EventRecord[]; cursor: string; status: string }>(url.pathname + url.search, {
      headers: authHeaders(currentSession)
    });
    sessionStatus.textContent = data.status;
    for (const item of data.events) {
      appendEvent(item);
    }
    eventCursor = data.cursor || eventCursor;
  } catch (error) {
    sessionStatus.textContent = errorMessage(error);
  }
}

function appendEvent(event: EventRecord) {
  const item = document.createElement("article");
  item.className = `event ${event.type}`;
  const time = document.createElement("time");
  time.dateTime = new Date(event.ts).toISOString();
  time.textContent = new Date(event.ts).toLocaleTimeString();
  const message = document.createElement("p");
  message.textContent = event.message;
  item.appendChild(time);
  item.appendChild(message);
  if (event.output) {
    const pre = document.createElement("pre");
    pre.textContent = event.output;
    item.appendChild(pre);
  }
  if (event.downloadId) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "download-action";
    button.dataset.downloadId = event.downloadId;
    button.dataset.path = event.path || "download";
    button.textContent = "Download";
    item.appendChild(button);
  }
  output.insertBefore(item, output.firstChild);
}

async function request<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = await response.text();
    throw new Error(payload || `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function authHeaders(session: StoredSession, headers: HeadersInit = {}): HeadersInit {
  return {
    ...headers,
    Authorization: `Bearer ${session.helperToken}`
  };
}

function setSubmitting(form: HTMLFormElement, submitting: boolean) {
  for (const button of form.querySelectorAll("button")) {
    button.disabled = submitting;
  }
}

function readSession(): StoredSession | null {
  const stored = localStorage.getItem("remote.stoff.dev.session");
  if (!stored) return null;
  try {
    return JSON.parse(stored) as StoredSession;
  } catch {
    localStorage.removeItem("remote.stoff.dev.session");
    return null;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

function mustElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}
