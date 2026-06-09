import { app } from "./worker/app";
import { cleanupExpiredSessions } from "./worker/services/session-store";
import type { Env } from "./worker/env";

export { CommandBridge } from "./worker/durable-objects/command-bridge";

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await cleanupExpiredSessions(env);
  }
} satisfies ExportedHandler<Env>;
