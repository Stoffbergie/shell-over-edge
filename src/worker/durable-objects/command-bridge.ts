import { DurableObject } from "cloudflare:workers";
import type { DirectAttempt, DirectAttemptPayload, DirectCandidate, DirectCandidatePayload, DirectCandidateRole } from "../../domain/direct";
import { normalizeDirectRole, normalizeDirectTransport, normalizeDirectUrl, normalizePriority, sortDirectCandidates } from "../../domain/direct";
import { directCandidateTtlMs, maxCommandBytes, maxDirectCandidatesPerRole, maxResultBytes } from "../../shared/config";
import { base64Encode, randomId } from "../../shared/crypto";
import { cleanString, jsonResponse, normalizeTimeout, readLimitedText, textResponse } from "../../shared/http";
import { logInfo } from "../../shared/log";
import type { Env } from "../env";

type BridgeCommand = {
  id: string;
  type: "shell";
  body: string;
  cwd: string;
  timeoutSeconds: number;
};

type CommandPayload = {
  body?: unknown;
  cwd?: unknown;
  timeoutSeconds?: unknown;
};

type ResponseWaiter = {
  commandId?: string;
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
};

const maxSendWaitMs = 55_000;
const nextWaitMs = 25_000;

export class CommandBridge extends DurableObject<Env> {
  private queued: BridgeCommand[] = [];
  private nextWaiters: ResponseWaiter[] = [];
  private resultWaiters = new Map<string, ResponseWaiter>();
  private candidates: DirectCandidate[] = [];
  private attempts: DirectAttempt[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/send") return this.sendCommand(request);
    if (url.pathname === "/next") return this.nextCommand(request);
    if (url.pathname.startsWith("/result/")) return this.receiveResult(request, cleanString(url.pathname.slice("/result/".length), 200));
    if (url.pathname === "/candidates" && request.method === "POST") return this.publishCandidate(request);
    if (url.pathname === "/candidates" && request.method === "GET") return this.listCandidates(url.searchParams.get("role"));
    if (url.pathname === "/direct-attempts" && request.method === "POST") return this.recordDirectAttempt(request);
    if (url.pathname === "/end") return this.endSession();
    return textResponse("Not found\n", 404);
  }

  private async sendCommand(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => ({})) as CommandPayload;
    const body = cleanString(payload.body, maxCommandBytes).trim();
    if (!body) return textResponse("Command body is required\n", 400);

    const command: BridgeCommand = {
      id: randomId(),
      type: "shell",
      body,
      cwd: cleanString(payload.cwd, 500),
      timeoutSeconds: normalizeTimeout(payload.timeoutSeconds ?? 30)
    };

    const waitMs = Math.min(command.timeoutSeconds * 1000 + 1000, maxSendWaitMs);
    const response = new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.resultWaiters.delete(command.id);
        this.removeQueued(command.id);
        logInfo("command_timeout", { commandId: command.id, waitMs });
        resolve(textResponse("Timed out waiting for command result\n", 504));
      }, waitMs);
      this.resultWaiters.set(command.id, { commandId: command.id, resolve, timer });
    });

    this.dispatch(command);
    logInfo("command_sent", { commandId: command.id, bytes: command.body.length, timeoutSeconds: command.timeoutSeconds });
    return response;
  }

  private nextCommand(request: Request): Response | Promise<Response> {
    const command = this.queued.shift();
    if (command) return commandResponse(command);

    return new Promise<Response>((resolve) => {
      let settled = false;
      const finish = (response: Response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.nextWaiters = this.nextWaiters.filter((waiter) => waiter.resolve !== finish);
        resolve(response);
      };
      const timer = setTimeout(() => finish(new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } })), nextWaitMs);
      this.nextWaiters.push({ resolve: finish, timer });
      request.signal.addEventListener("abort", () => finish(new Response(null, { status: 499 })), { once: true });
    });
  }

  private async receiveResult(request: Request, commandId: string): Promise<Response> {
    const waiter = this.resultWaiters.get(commandId);
    if (!waiter) return textResponse("Command not found\n", 404);

    const exitCode = parseExitCode(new URL(request.url).searchParams.get("exit"));
    const output = await readLimitedText(request, maxResultBytes);
    clearTimeout(waiter.timer);
    this.resultWaiters.delete(commandId);
    waiter.resolve(new Response(output, {
      status: exitCode === 0 ? 200 : 500,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Command-Id": commandId,
        "X-Exit-Code": String(exitCode)
      }
    }));
    logInfo("command_result", { commandId, exitCode, status: exitCode === 0 ? "completed" : "failed", bytes: output.length });
    return textResponse("ok\n");
  }

  private async publishCandidate(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => ({})) as DirectCandidatePayload;
    const role = normalizeDirectRole(payload.role);
    const transport = normalizeDirectTransport(payload.transport);
    const url = normalizeDirectUrl(payload.url);
    if (!role || !transport || !url) return textResponse("Invalid direct candidate\n", 400);

    const now = Date.now();
    const ttlSeconds = Number(payload.ttlSeconds);
    const ttlMs = Number.isFinite(ttlSeconds) ? Math.min(Math.max(Math.trunc(ttlSeconds), 1), 120) * 1000 : directCandidateTtlMs;
    const candidate: DirectCandidate = {
      id: randomId(),
      role,
      transport,
      url,
      priority: normalizePriority(payload.priority),
      createdAt: now,
      expiresAt: now + ttlMs
    };

    this.pruneCandidates(now);
    this.candidates = [
      candidate,
      ...this.candidates.filter((item) => !(item.role === candidate.role && item.url === candidate.url))
    ];
    this.trimCandidates(candidate.role);
    logInfo("direct_candidate_published", { candidateId: candidate.id, role: candidate.role, priority: candidate.priority });
    return jsonResponse(candidate, 201);
  }

  private listCandidates(roleValue: string | null): Response {
    const now = Date.now();
    this.pruneCandidates(now);
    const role = roleValue ? normalizeDirectRole(roleValue) : undefined;
    if (roleValue && !role) return textResponse("Invalid direct candidate role\n", 400);
    const candidates = sortDirectCandidates(role ? this.candidates.filter((candidate) => candidate.role === role) : this.candidates);
    return jsonResponse({ candidates });
  }

  private async recordDirectAttempt(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => ({})) as DirectAttemptPayload;
    const attempt: DirectAttempt = {
      candidateId: cleanString(payload.candidateId, 200),
      ok: payload.ok === true,
      latencyMs: normalizeLatency(payload.latencyMs),
      reason: cleanString(payload.reason, 120),
      createdAt: Date.now()
    };
    if (!attempt.candidateId) return textResponse("Invalid direct attempt\n", 400);
    this.attempts = [attempt, ...this.attempts].slice(0, 40);
    logInfo("direct_attempt", { candidateId: attempt.candidateId, ok: attempt.ok, latencyMs: attempt.latencyMs, reason: attempt.reason });
    return textResponse("ok\n");
  }

  private endSession(): Response {
    for (const waiter of this.nextWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(textResponse("Session ended\n", 410));
    }
    for (const waiter of this.resultWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(textResponse("Session ended\n", 410));
    }
    this.nextWaiters = [];
    this.resultWaiters.clear();
    this.queued = [];
    this.candidates = [];
    this.attempts = [];
    return textResponse("ended\n");
  }

  private dispatch(command: BridgeCommand): void {
    const waiter = this.nextWaiters.shift();
    if (!waiter) {
      this.queued.push(command);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(commandResponse(command));
  }

  private removeQueued(commandId: string): void {
    this.queued = this.queued.filter((command) => command.id !== commandId);
  }

  private pruneCandidates(now: number): void {
    this.candidates = this.candidates.filter((candidate) => candidate.expiresAt > now);
  }

  private trimCandidates(role: DirectCandidateRole): void {
    const keep = sortDirectCandidates(this.candidates.filter((candidate) => candidate.role === role)).slice(0, maxDirectCandidatesPerRole);
    const keepIds = new Set(keep.map((candidate) => candidate.id));
    this.candidates = this.candidates.filter((candidate) => candidate.role !== role || keepIds.has(candidate.id));
  }
}

function commandResponse(command: BridgeCommand): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/octet-stream",
    "X-Command-Id": command.id,
    "X-Command-Type": command.type,
    "X-Command-Timeout": String(command.timeoutSeconds)
  });
  if (command.cwd) headers.set("X-Command-Cwd-Base64", base64Encode(command.cwd));
  return new Response(command.body, { headers });
}

function parseExitCode(value: string | null): number {
  const parsed = Number(value || "0");
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 1;
}

function normalizeLatency(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(Math.trunc(parsed), 0), 60_000);
}
