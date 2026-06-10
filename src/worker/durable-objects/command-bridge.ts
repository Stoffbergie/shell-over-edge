import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { CommandBridgeCore } from "./command-bridge-core";

export class CommandBridge extends DurableObject<Env> {
  private readonly core = new CommandBridgeCore();

  async fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }
}
