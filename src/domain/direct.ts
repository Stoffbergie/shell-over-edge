export type DirectRole = "agent" | "client";
export type DirectTransport = "http" | "webrtc";
export type WebRtcSignalKind = "offer" | "answer" | "candidate";

export type DirectSignal = {
  id: string;
  role: DirectRole;
  transport: DirectTransport;
  url?: string;
  data?: WebRtcSignalData;
  priority: number;
  createdAt: number;
  expiresAt: number;
};

export type HttpDirectSignal = DirectSignal & {
  transport: "http";
  url: string;
};

export type WebRtcSignalData = {
  kind: WebRtcSignalKind;
  sdp?: string;
  candidate?: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
};

export type IceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

export type IceServerPayload = {
  iceServers?: unknown;
};

export type DirectSignalPayload = {
  role?: unknown;
  transport?: unknown;
  url?: unknown;
  data?: unknown;
  priority?: unknown;
  ttlSeconds?: unknown;
};

export function normalizeDirectRole(value: unknown): DirectRole | undefined {
  return value === "agent" || value === "client" ? value : undefined;
}

export function normalizeDirectTransport(value: unknown): DirectTransport | undefined {
  if (value === undefined) return "http";
  return value === "http" || value === "webrtc" ? value : undefined;
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

export function normalizeDirectSignal(payload: DirectSignalPayload, id: string, now: number, defaultTtlMs: number): DirectSignal | undefined {
  const role = normalizeDirectRole(payload.role);
  const transport = normalizeDirectTransport(payload.transport);
  if (!role || !transport) return undefined;

  const ttlSeconds = Number(payload.ttlSeconds);
  const ttlMs = Number.isFinite(ttlSeconds) ? Math.min(Math.max(Math.trunc(ttlSeconds), 1), 120) * 1000 : defaultTtlMs;
  const signal: DirectSignal = {
    id,
    role,
    transport,
    priority: normalizePriority(payload.priority),
    createdAt: now,
    expiresAt: now + ttlMs
  };

  if (transport === "http") {
    const url = normalizeDirectUrl(payload.url);
    if (!url) return undefined;
    signal.url = url;
    return signal;
  }

  const data = normalizeWebRtcSignalData(payload.data);
  if (!data) return undefined;
  signal.data = data;
  return signal;
}

export function normalizeWebRtcSignalData(value: unknown): WebRtcSignalData | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "offer" || value.type === "answer") {
    const sdp = cleanSignalString(value.sdp, 24 * 1024);
    return sdp ? { kind: value.type, sdp } : undefined;
  }
  if (value.kind === "offer" || value.kind === "answer") {
    const sdp = cleanSignalString(value.sdp, 24 * 1024);
    return sdp ? { kind: value.kind, sdp } : undefined;
  }
  const candidate = cleanSignalString(value.candidate, 4 * 1024);
  if (!candidate) return undefined;
  const data: WebRtcSignalData = { kind: "candidate", candidate };
  const sdpMid = cleanSignalString(value.sdpMid, 120);
  if (sdpMid) data.sdpMid = sdpMid;
  const sdpMLineIndex = Number(value.sdpMLineIndex);
  if (Number.isFinite(sdpMLineIndex)) data.sdpMLineIndex = Math.min(Math.max(Math.trunc(sdpMLineIndex), 0), 1000);
  return data;
}

export function normalizeIceServers(value: unknown): IceServer[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeIceServer).filter((server): server is IceServer => Boolean(server));
}

export function isHttpDirectSignal(signal: DirectSignal): signal is HttpDirectSignal {
  return signal.transport === "http" && Boolean(signal.url);
}

export function directSignalKey(signal: DirectSignal): string {
  return [signal.role, signal.transport, signal.url || "", signal.data ? JSON.stringify(signal.data) : ""].join("\0");
}

export function sortDirectSignals(signals: DirectSignal[]): DirectSignal[] {
  return [...signals].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
}

function normalizeIceServer(value: unknown): IceServer | undefined {
  if (!isRecord(value)) return undefined;
  const urls = Array.isArray(value.urls)
    ? value.urls.map((url) => cleanIceUrl(url)).filter(Boolean)
    : [cleanIceUrl(value.urls)].filter(Boolean);
  if (urls.length === 0) return undefined;
  const server: IceServer = { urls };
  const username = cleanSignalString(value.username, 500);
  const credential = cleanSignalString(value.credential, 500);
  if (username) server.username = username;
  if (credential) server.credential = credential;
  return server;
}

function cleanIceUrl(value: unknown): string {
  const url = cleanSignalString(value, 500);
  return /^(stun|turn|turns):/i.test(url) ? url : "";
}

function cleanSignalString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
