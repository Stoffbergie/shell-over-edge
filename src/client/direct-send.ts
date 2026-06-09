import type { DirectSignal, HttpDirectSignal } from "../domain/direct";
import { isHttpDirectSignal, sortDirectSignals } from "../domain/direct";

export type DirectSendInput = {
  body: string;
  cwd?: string;
  timeoutSeconds?: number;
};

export type DirectSendOptions = DirectSendInput & {
  baseUrl: string;
  sessionId: string;
  directTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type SignalList = {
  signals?: DirectSignal[];
};

const defaultDirectTimeoutMs = 300;

export async function sendWithDirectFallback(options: DirectSendOptions): Promise<Response> {
  const fetcher = options.fetchImpl || fetch;
  const command = commandPayload(options);
  const signals = await loadAgentSignals(options.baseUrl, options.sessionId, fetcher);

  for (const signal of signals) {
    const startedAt = Date.now();
    const direct = await tryDirectSignal(fetcher, signal, options.sessionId, command, options.directTimeoutMs || defaultDirectTimeoutMs);
    const latencyMs = Date.now() - startedAt;
    if (direct) return tagResponse(direct, "direct", signal.id, latencyMs);
  }

  const relay = await fetcher(`${trimBaseUrl(options.baseUrl)}/api/sessions/${options.sessionId}/send`, {
    method: "POST",
    body: JSON.stringify(command)
  });
  return tagResponse(relay, "relay");
}

export async function publishDirectSignal(baseUrl: string, sessionId: string, signal: {
  role: "agent" | "client";
  url: string;
  priority?: number;
  ttlSeconds?: number;
}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  return fetchImpl(`${trimBaseUrl(baseUrl)}/api/sessions/${sessionId}/signals`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      role: signal.role,
      transport: "http",
      url: signal.url,
      priority: signal.priority,
      ttlSeconds: signal.ttlSeconds
    })
  });
}

async function loadAgentSignals(baseUrl: string, sessionId: string, fetcher: typeof fetch): Promise<HttpDirectSignal[]> {
  const response = await fetcher(`${trimBaseUrl(baseUrl)}/api/sessions/${sessionId}/signals?role=agent`);
  if (!response.ok) return [];
  const payload = await response.json().catch(() => ({})) as SignalList;
  return sortDirectSignals(Array.isArray(payload.signals) ? payload.signals : []).filter(isHttpDirectSignal);
}

async function tryDirectSignal(fetcher: typeof fetch, signal: HttpDirectSignal, sessionId: string, command: DirectSendInput, timeoutMs: number): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(signal.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SOE-Signal-Id": signal.id,
        "X-SOE-Session-Id": sessionId
      },
      body: JSON.stringify(command),
      signal: controller.signal
    });
    if (response.ok || response.headers.has("X-Exit-Code")) return response;
    await response.arrayBuffer();
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function tagResponse(response: Response, transport: "direct" | "relay", signalId = "", latencyMs = 0): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("X-SOE-Transport", transport);
  if (signalId) headers.set("X-SOE-Direct-Signal-Id", signalId);
  if (latencyMs > 0) headers.set("X-SOE-Direct-Latency-Ms", String(latencyMs));
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function commandPayload(input: DirectSendInput): DirectSendInput {
  return {
    body: input.body,
    cwd: input.cwd || "",
    timeoutSeconds: input.timeoutSeconds || 30
  };
}

function trimBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}
