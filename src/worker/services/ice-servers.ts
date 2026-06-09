import type { IceServer, IceServerPayload } from "../../domain/direct";
import { normalizeIceServers } from "../../domain/direct";
import { defaultTurnCredentialTtlSeconds, maxTurnCredentialTtlSeconds } from "../../shared/config";
import type { Env } from "../env";

export type IceServerResult = {
  iceServers: IceServer[];
  source: "cloudflare-turn" | "cloudflare-stun";
  turnEnabled: boolean;
  ttlSeconds: number;
};

const cloudflareStunServers: IceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478"] }
];

export async function getIceServers(env: Env, fetcher: typeof fetch = fetch): Promise<IceServerResult> {
  const ttlSeconds = normalizeTurnCredentialTtl(env.TURN_CREDENTIAL_TTL_SECONDS);
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return stunOnly(ttlSeconds);
  }

  const response = await fetcher(`${turnApiBaseUrl(env)}/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TURN_KEY_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ttl: ttlSeconds })
  }).catch(() => undefined);
  if (!response?.ok) return stunOnly(ttlSeconds);

  const payload = await response.json().catch(() => ({})) as IceServerPayload;
  const iceServers = normalizeIceServers(payload.iceServers).map(filterBrowserHostileIcePorts).filter((server) => server.urls.length > 0);
  if (iceServers.length === 0) return stunOnly(ttlSeconds);
  return {
    iceServers,
    source: "cloudflare-turn",
    turnEnabled: iceServers.some((server) => server.urls.some((url) => /^turns?:/i.test(url))),
    ttlSeconds
  };
}

export function normalizeTurnCredentialTtl(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultTurnCredentialTtlSeconds;
  return Math.min(Math.max(Math.trunc(parsed), 60), maxTurnCredentialTtlSeconds);
}

function stunOnly(ttlSeconds: number): IceServerResult {
  return {
    iceServers: cloudflareStunServers,
    source: "cloudflare-stun",
    turnEnabled: false,
    ttlSeconds
  };
}

function filterBrowserHostileIcePorts(server: IceServer): IceServer {
  return {
    ...server,
    urls: server.urls.filter((url) => !/:(53)(\?|$)/.test(url))
  };
}

function turnApiBaseUrl(env: Env): string {
  return (env.TURN_API_BASE_URL || "https://rtc.live.cloudflare.com").replace(/\/$/, "");
}
