import { lookup, resolve4 } from "node:dns/promises";
import http from "node:http";
import https from "node:https";

const baseUrl = (process.env.SOE_BASE_URL || process.argv.find((arg) => arg.startsWith("--base-url="))?.slice("--base-url=".length) || "https://soe.stoff.dev").replace(/\/$/, "");
const retryableDnsCodes = new Set(["ENOTFOUND", "EAI_AGAIN"]);

async function request(path, init = {}) {
  const url = new URL(path, `${baseUrl}/`);
  const body = init.body == null ? undefined : Buffer.from(init.body);
  return requestText(url, {
    body,
    headers: init.headers || {},
    method: init.method || "GET"
  });
}

async function requestUntil(path, init, ready) {
  let result;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    result = await request(path, init);
    if (ready(result)) return result;
    await sleep(1000);
  }
  return result;
}

function requestText(url, init) {
  const client = url.protocol === "http:" ? http : https;
  const headers = { ...init.headers };
  if (init.body && !hasHeader(headers, "content-length")) {
    headers["Content-Length"] = String(init.body.byteLength);
  }

  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      headers,
      lookup: resilientLookup,
      method: init.method,
      timeout: 15000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const status = response.statusCode || 0;
        resolve({
          response: {
            ok: status >= 200 && status < 300,
            status,
            headers: response.headers
          },
          text: Buffer.concat(chunks).toString("utf8")
        });
      });
    });

    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error(`Request timed out after 15000ms: ${url.href}`)));
    if (init.body) request.write(init.body);
    request.end();
  });
}

function resilientLookup(hostname, options, callback) {
  resolveHost(hostname, options).then((result) => {
    if (Array.isArray(result)) {
      callback(null, result);
      return;
    }
    callback(null, result.address, result.family);
  }, callback);
}

async function resolveHost(hostname, options) {
  try {
    return await lookup(hostname, options);
  } catch (error) {
    if (!retryableDnsCodes.has(error.code)) throw error;
    const records = await resolve4(hostname);
    if (records.length === 0) throw error;
    const addresses = records.map((address) => ({ address, family: 4 }));
    return options.all ? addresses : addresses[0];
  }
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((header) => header.toLowerCase() === name);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const root = await request("/");
assert(root.response.ok, `GET / returned ${root.response.status}`);
assert(root.text.includes("Shell Over Edge"), "GET / did not return Shell Over Edge usage");
assert(root.text.includes("/api/sessions/<code>/send"), "GET / did not return simplified send usage");
assert(root.text.includes(`${baseUrl}/a | sh`), "GET / did not return bootstrap usage");

const legacy = await request("/connect.sh");
assert(legacy.response.status === 404, `legacy connect.sh should be disabled, got ${legacy.response.status}`);

const bootstrap = await request("/a");
assert(bootstrap.response.ok, `GET /a returned ${bootstrap.response.status}: ${bootstrap.text}`);
assert(bootstrap.text.includes("SOE_NO_END_ON_EXIT=1 sh \"$AGENT_FILE\""), "POSIX bootstrap does not start relay with upgrade-safe mode");
assert(bootstrap.text.includes("download_native"), "POSIX bootstrap does not include native download path");
assert(bootstrap.text.includes("SOE_WARM_NATIVE"), "POSIX bootstrap does not gate native warmup");

const psBootstrap = await request("/a.ps1");
assert(psBootstrap.response.ok, `GET /a.ps1 returned ${psBootstrap.response.status}: ${psBootstrap.text}`);
assert(psBootstrap.text.includes("$env:SOE_NO_END_ON_EXIT = \"1\""), "PowerShell bootstrap does not start relay with upgrade-safe mode");
assert(psBootstrap.text.includes("Start-NativeDownload"), "PowerShell bootstrap does not include native download path");
assert(psBootstrap.text.includes("SOE_WARM_NATIVE"), "PowerShell bootstrap does not gate native warmup");

const session = await request("/api/sessions", {
  method: "POST"
});
assert(session.response.ok, `POST /api/sessions returned ${session.response.status}: ${session.text}`);

const id = session.response.headers["x-session-id"];
assert(isSessionCode(id), "session code header missing");
assert(session.text.startsWith("#!/bin/sh"), "session response is not a shell script");
assert(session.text.includes(`/api/sessions/$SESSION_ID/next`), "shell script does not poll the simplified session route");
assert(!session.text.includes("Authorization"), "shell script should not use authorization headers");
assert(!session.text.includes("?token" + "="), "shell script leaks token in URL");

const powerShell = await request("/api/sessions.ps1", {
  method: "POST"
});
assert(powerShell.response.ok, `POST /api/sessions.ps1 returned ${powerShell.response.status}: ${powerShell.text}`);
const powerShellId = powerShell.response.headers["x-session-id"];
assert(isSessionCode(powerShellId), "PowerShell session code header missing");
assert(powerShell.text.includes(`$SessionId = "${powerShellId}"`), "PowerShell script does not embed its session id");
assert(powerShell.text.includes("/api/sessions/$SessionId/next"), "PowerShell script does not poll the simplified session route");
assert(!powerShell.text.includes("Authorization"), "PowerShell script should not use authorization headers");

const powerShellEnd = await request(`/api/sessions/${powerShellId}/end`, {
  method: "POST"
});
assert(powerShellEnd.response.ok, `PowerShell session end returned ${powerShellEnd.response.status}: ${powerShellEnd.text}`);

const hello = await request(`/api/sessions/${id}/hello`, {
  method: "POST",
  headers: {
    "X-Agent-Platform": "smoke",
    "X-Agent-User": "smoke"
  },
  body: process.cwd()
});
assert(hello.response.ok, `agent hello returned ${hello.response.status}: ${hello.text}`);

const ice = await requestUntil(`/api/sessions/${id}/ice`, {}, (result) => result.response.status !== 404);
assert(ice.response.ok, `ICE config returned ${ice.response.status}: ${ice.text}`);
const icePayload = JSON.parse(ice.text);
assert(Array.isArray(icePayload.iceServers), "ICE config did not return iceServers");
assert(ice.text.includes("stun:stun.cloudflare.com:3478"), "ICE config did not include Cloudflare STUN fallback");

const signal = await requestUntil(`/api/sessions/${id}/signals`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: '{"role":"agent","transport":"http","url":"http://127.0.0.1:9/direct","priority":1,"ttlSeconds":60}'
}, (result) => result.response.status !== 404);
assert(signal.response.status === 201, `direct signal returned ${signal.response.status}: ${signal.text}`);
const signalPayload = JSON.parse(signal.text);
assert(signalPayload.id, "direct signal id missing");
assert(signalPayload.role === "agent", "direct signal role is wrong");

const signals = await requestUntil(`/api/sessions/${id}/signals?role=agent`, {}, (result) => result.response.status !== 404);
assert(signals.response.ok, `direct signal list returned ${signals.response.status}: ${signals.text}`);
assert(signals.text.includes(signalPayload.id), "direct signal list did not include published signal");

const retiredDirectAttempt = await request(`/api/sessions/${id}/direct-attempts`, {
  method: "POST"
});
assert(retiredDirectAttempt.response.status === 404, `direct-attempts should be retired, got ${retiredDirectAttempt.response.status}`);

const send = request(`/api/sessions/${id}/send`, {
  method: "POST",
  body: '{"body":"printf smoke-prod","timeoutSeconds":10}'
});

const next = await request(`/api/sessions/${id}/next`);
assert(next.response.ok, `agent next returned ${next.response.status}: ${next.text}`);
const commandId = next.response.headers["x-command-id"];
assert(commandId, "agent next did not return a command id");
assert(next.text === "printf smoke-prod", "agent next returned the wrong command body");

const result = await request(`/api/sessions/${id}/result/${commandId}?exit=0`, {
  method: "POST",
  body: "smoke-prod"
});
assert(result.response.ok, `agent result returned ${result.response.status}: ${result.text}`);

const sendResult = await send;
assert(sendResult.response.ok, `send returned ${sendResult.response.status}: ${sendResult.text}`);
assert(sendResult.text === "smoke-prod", "send returned the wrong command output");

const ended = await request(`/api/sessions/${id}/end`, {
  method: "POST"
});
assert(ended.response.ok, `session end returned ${ended.response.status}: ${ended.text}`);
assert(ended.text === "ended\n", "session end payload is wrong");

const blocked = await request(`/api/sessions/${id}/send`, {
  method: "POST",
  body: "pwd"
});
assert(blocked.response.status === 410, `ended session send should be 410, got ${blocked.response.status}`);
assert(blocked.text === "Session ended\n", "ended session send payload is wrong");

function isSessionCode(value) {
  return /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(value || "");
}

console.log(`production smoke passed for ${baseUrl}`);
