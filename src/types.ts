export type Env = {
  SOE_MAILBOX: R2Bucket;
  COMMAND_BRIDGES: DurableObjectNamespace;
  BASE_URL?: string;
  ENABLE_LEGACY_BRIDGE?: string;
};

export type SessionStatus = "waiting" | "connected" | "agent_stopped" | "ended" | "expired";
export type CommandType = "shell";
export type CommandStatus = "queued" | "running" | "completed" | "failed";

export type SessionMeta = {
  id: string;
  code: string;
  helperName: string;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
  endedAt?: number;
  expiredEventWritten?: boolean;
};

export type CommandRecord = {
  id: string;
  type: CommandType;
  status: CommandStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  body?: string;
  cwd?: string;
  timeoutSeconds: number;
  exitCode?: number;
  output?: string;
};

export type EventRecord = {
  id: string;
  ts: number;
  type: string;
  message: string;
  commandId?: string;
  output?: string;
  status?: SessionStatus;
  exitCode?: number;
};

export type CommandWaiter = {
  commandId: string;
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type HelperGuard = { meta: SessionMeta } | { response: Response };
export type AgentGuard = { meta: SessionMeta } | { response: Response };
