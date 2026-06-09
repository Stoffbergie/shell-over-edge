import type { Env } from "./types";

export function sessionBridge(env: Env, sessionId: string): DurableObjectStub {
  return env.COMMAND_BRIDGES.get(env.COMMAND_BRIDGES.idFromName(sessionId));
}
