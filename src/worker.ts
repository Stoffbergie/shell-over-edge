import { app } from "./app";
import { cleanupExpiredSessions } from "./session-store";
import type { Env } from "./types";

export { CommandBridge } from "./bridge";

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await cleanupExpiredSessions(env);
  }
} satisfies ExportedHandler<Env>;
