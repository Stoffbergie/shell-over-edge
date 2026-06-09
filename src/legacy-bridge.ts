import type { Env } from "./types";

export function bridgeStub(env: Env, code: string): DurableObjectStub {
  return env.COMMAND_BRIDGES.get(env.COMMAND_BRIDGES.idFromName(code));
}
