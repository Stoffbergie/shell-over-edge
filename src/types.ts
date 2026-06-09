export type Env = {
  SOE_MAILBOX: R2Bucket;
  COMMAND_BRIDGES: DurableObjectNamespace;
  BASE_URL?: string;
  ENABLE_LEGACY_BRIDGE?: string;
};

export type SessionStatus = "waiting" | "connected" | "agent_stopped" | "ended" | "expired";
export type CommandType = "shell" | "write-file" | "read-file";
export type CommandStatus = "queued" | "running" | "completed" | "failed";

export type SessionMeta = {
  id: string;
  code: string;
  helperName: string;
  helperTokenHash: string;
  agentTokenHash: string;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
  endedAt?: number;
  expiredEventWritten?: boolean;
};

export type CodeIndex = {
  id: string;
  code: string;
  createdAt: number;
  expiresAt: number;
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
  path?: string;
  uploadKey?: string;
  uploadName?: string;
  uploadSize?: number;
  downloadId?: string;
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
  downloadId?: string;
  path?: string;
  size?: number;
};

export type CommandWaiter = {
  commandId: string;
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type HelperGuard = { meta: SessionMeta } | { response: Response };
export type AgentGuard = { meta: SessionMeta } | { response: Response };
