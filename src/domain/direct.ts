export type DirectCandidateRole = "agent" | "client";
export type DirectCandidateTransport = "http";

export type DirectCandidate = {
  id: string;
  role: DirectCandidateRole;
  transport: DirectCandidateTransport;
  url: string;
  priority: number;
  createdAt: number;
  expiresAt: number;
};

export type DirectCandidatePayload = {
  role?: unknown;
  transport?: unknown;
  url?: unknown;
  priority?: unknown;
  ttlSeconds?: unknown;
};

export type DirectAttemptPayload = {
  candidateId?: unknown;
  ok?: unknown;
  latencyMs?: unknown;
  reason?: unknown;
};

export type DirectAttempt = {
  candidateId: string;
  ok: boolean;
  latencyMs: number;
  reason: string;
  createdAt: number;
};

export function normalizeDirectRole(value: unknown): DirectCandidateRole | undefined {
  return value === "agent" || value === "client" ? value : undefined;
}

export function normalizeDirectTransport(value: unknown): DirectCandidateTransport | undefined {
  return value === "http" || value === undefined ? "http" : undefined;
}

export function normalizeDirectUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 1000) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizePriority(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(Math.trunc(parsed), 0), 1000);
}

export function sortDirectCandidates(candidates: DirectCandidate[]): DirectCandidate[] {
  return [...candidates].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
}
