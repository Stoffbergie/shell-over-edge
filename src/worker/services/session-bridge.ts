import type { Env } from "../env";

export function sessionBridge(env: Env, sessionId: string): DurableObjectStub {
  return env.COMMAND_BRIDGES.get(env.COMMAND_BRIDGES.idFromName(sessionId));
}
