export type SessionStatus = "waiting" | "ended" | "expired";

export type SessionMeta = {
  id: string;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
  endedAt?: number;
};
