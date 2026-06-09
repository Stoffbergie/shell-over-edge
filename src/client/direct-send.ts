import type { DirectCandidate } from "../domain/direct";
import { sortDirectCandidates } from "../domain/direct";

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

type CandidateList = {
  candidates?: DirectCandidate[];
};

const defaultDirectTimeoutMs = 300;

export async function sendWithDirectFallback(options: DirectSendOptions): Promise<Response> {
  const fetcher = options.fetchImpl || fetch;
  const command = commandPayload(options);
  const candidates = await loadAgentCandidates(options.baseUrl, options.sessionId, fetcher);

  for (const candidate of candidates) {
    const startedAt = Date.now();
    const direct = await tryDirectCandidate(fetcher, candidate, options.sessionId, command, options.directTimeoutMs || defaultDirectTimeoutMs);
    const latencyMs = Date.now() - startedAt;
    void reportDirectAttempt(options.baseUrl, options.sessionId, fetcher, {
      candidateId: candidate.id,
      ok: direct.ok,
      latencyMs,
      reason: direct.reason
    });
    if (direct.response) return tagResponse(direct.response, "direct", candidate.id, latencyMs);
  }

  const relay = await fetcher(`${trimBaseUrl(options.baseUrl)}/api/sessions/${options.sessionId}/send`, {
    method: "POST",
    body: JSON.stringify(command)
  });
  return tagResponse(relay, "relay");
}

export async function publishDirectCandidate(baseUrl: string, sessionId: string, candidate: {
  role: "agent" | "client";
  url: string;
  priority?: number;
  ttlSeconds?: number;
}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  return fetchImpl(`${trimBaseUrl(baseUrl)}/api/sessions/${sessionId}/candidates`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      role: candidate.role,
      transport: "http",
      url: candidate.url,
      priority: candidate.priority,
      ttlSeconds: candidate.ttlSeconds
    })
  });
}

async function loadAgentCandidates(baseUrl: string, sessionId: string, fetcher: typeof fetch): Promise<DirectCandidate[]> {
  const response = await fetcher(`${trimBaseUrl(baseUrl)}/api/sessions/${sessionId}/candidates?role=agent`);
  if (!response.ok) return [];
  const payload = await response.json().catch(() => ({})) as CandidateList;
  return sortDirectCandidates(Array.isArray(payload.candidates) ? payload.candidates : []);
}

async function tryDirectCandidate(fetcher: typeof fetch, candidate: DirectCandidate, sessionId: string, command: DirectSendInput, timeoutMs: number): Promise<{
  ok: boolean;
  reason: string;
  response?: Response;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(candidate.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SOE-Candidate-Id": candidate.id,
        "X-SOE-Session-Id": sessionId
      },
      body: JSON.stringify(command),
      signal: controller.signal
    });
    if (response.ok || response.headers.has("X-Exit-Code")) return { ok: true, reason: "connected", response };
    await response.arrayBuffer();
    return { ok: false, reason: `http-${response.status}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : "network-error" };
  } finally {
    clearTimeout(timer);
  }
}

async function reportDirectAttempt(baseUrl: string, sessionId: string, fetcher: typeof fetch, attempt: {
  candidateId: string;
  ok: boolean;
  latencyMs: number;
  reason: string;
}): Promise<void> {
  await fetcher(`${trimBaseUrl(baseUrl)}/api/sessions/${sessionId}/direct-attempts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(attempt)
  }).catch(() => undefined);
}

async function tagResponse(response: Response, transport: "direct" | "relay", candidateId = "", latencyMs = 0): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("X-SOE-Transport", transport);
  if (candidateId) headers.set("X-SOE-Direct-Candidate-Id", candidateId);
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
