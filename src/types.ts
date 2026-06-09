export type Env = {
  SOE_MAILBOX: R2Bucket;
  COMMAND_BRIDGES: DurableObjectNamespace;
  BASE_URL?: string;
  ENABLE_LEGACY_BRIDGE?: string;
};

export type SessionStatus = "waiting" | "ended" | "expired";

export type SessionMeta = {
  id: string;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
  endedAt?: number;
};
