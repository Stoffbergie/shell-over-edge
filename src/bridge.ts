import { DurableObject } from "cloudflare:workers";
import { maxCommandBytes, maxResultBytes } from "./config";
import { base64Encode, randomId, textEncoder } from "./crypto";
import { jsonResponse, normalizeTimeout, readLimitedText, textResponse } from "./http";
import { logInfo } from "./log";
import type { CommandWaiter, Env } from "./types";

export class CommandBridge extends DurableObject<Env> {
  private agentWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private waiter?: CommandWaiter;
  private keepAlive?: ReturnType<typeof setInterval>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/events") return this.openEvents(request);
    if (url.pathname === "/command") return this.runCommand(request);
    if (url.pathname.startsWith("/result/")) return this.receiveResult(request, url.pathname.slice("/result/".length));
    if (url.pathname === "/bye") return this.closeAgent();
    return textResponse("Not found\n", 404);
  }

  private openEvents(request: Request): Response {
    this.closeWriter();
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    this.agentWriter = stream.writable.getWriter();
    this.writeSse("event: connected\ndata: ok\n\n");
    this.keepAlive = setInterval(() => {
      this.writeSse(": keepalive\n\n");
    }, 15000);
    request.signal.addEventListener("abort", () => {
      this.closeWriter();
    });
    logInfo("v1_agent_connected", { objectId: this.ctx.id.toString() });
    return new Response(stream.readable, {
      headers: {
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8"
      }
    });
  }

  private async runCommand(request: Request): Promise<Response> {
    if (!this.agentWriter) {
      logInfo("v1_command_no_agent", { objectId: this.ctx.id.toString() });
      return textResponse("No agent connected for that key\n", 404);
    }
    if (this.waiter) {
      logInfo("v1_command_conflict", { objectId: this.ctx.id.toString(), commandId: this.waiter.commandId });
      return textResponse("Another command is already running for this agent\n", 409);
    }
    const body = (await readLimitedText(request, maxCommandBytes)).trim();
    if (!body) return textResponse("Command body is required\n", 400);
    const commandId = randomId();
    const timeoutSeconds = normalizeTimeout(request.headers.get("x-timeout-seconds") || 30);
    const waitMs = Math.min(timeoutSeconds * 1000 + 5000, 55000);
    let resolveResult!: (response: Response) => void;
    const result = new Promise<Response>((resolve) => {
      resolveResult = resolve;
    });
    const timer = setTimeout(() => {
      if (this.waiter?.commandId === commandId) this.waiter = undefined;
      logInfo("v1_command_timeout", { objectId: this.ctx.id.toString(), commandId, waitMs });
      resolveResult(textResponse(`Command ${commandId} timed out waiting for a result\n`, 504));
    }, waitMs);
    this.waiter = { commandId, resolve: resolveResult, timer };
    try {
      await this.writeSse(`event: command\nid: ${commandId}\ndata: ${timeoutSeconds}:${base64Encode(body)}\n\n`);
    } catch {
      clearTimeout(timer);
      if (this.waiter?.commandId === commandId) this.waiter = undefined;
      this.closeWriter();
      logInfo("v1_command_send_failed", { objectId: this.ctx.id.toString(), commandId });
      return textResponse("Agent disconnected\n", 404);
    }
    logInfo("v1_command_sent", { objectId: this.ctx.id.toString(), commandId, bytes: body.length, timeoutSeconds });
    return result;
  }

  private async receiveResult(request: Request, commandId: string): Promise<Response> {
    if (!this.waiter || this.waiter.commandId !== commandId) {
      logInfo("v1_result_without_waiter", { objectId: this.ctx.id.toString(), commandId, waitingFor: this.waiter?.commandId || null });
      return jsonResponse({ error: "Command not found" }, 404);
    }
    const exitCode = Number(new URL(request.url).searchParams.get("exit") || "0");
    const output = await readLimitedText(request, maxResultBytes);
    const waiter = this.waiter;
    clearTimeout(waiter.timer);
    this.waiter = undefined;
    logInfo("v1_command_result", { objectId: this.ctx.id.toString(), commandId, exitCode, status: exitCode === 0 ? "completed" : "failed", bytes: output.length });
    waiter.resolve(new Response(output, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Command-Id": commandId,
        "X-Exit-Code": String(exitCode)
      }
    }));
    return jsonResponse({ ok: true });
  }

  private closeAgent(): Response {
    this.closeWriter();
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.resolve(textResponse("Agent disconnected\n", 410));
      this.waiter = undefined;
    }
    logInfo("v1_agent_stopped", { objectId: this.ctx.id.toString() });
    return jsonResponse({ ok: true });
  }

  private async writeSse(value: string): Promise<void> {
    await this.agentWriter?.write(textEncoder.encode(value));
  }

  private closeWriter(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = undefined;
    this.agentWriter?.close().catch(() => undefined);
    this.agentWriter = undefined;
  }
}
