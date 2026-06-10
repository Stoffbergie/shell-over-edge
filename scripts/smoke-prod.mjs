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

function requestText(url, init) {
  const client = url.protocol === "http:" ? http : https;
  const headers = { ...init.headers };
  if (init.body && !hasHeader(headers, "content-length")) {
    headers["Content-Length"] = String(init.body.byteLength);
  }

  return new Promise((resolve, reject) => {
    const req = client.request(url, {
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

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`Request timed out after 15000ms: ${url.href}`)));
    if (init.body) req.write(init.body);
    req.end();
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

function isSessionCode(value) {
  return /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(value || "");
}

const root = await request("/");
assert(root.response.ok, `GET / returned ${root.response.status}`);
assert(root.text.includes("Shell Over Edge"), "GET / did not return Shell Over Edge usage");
assert(root.text.includes("/api/sessions/<code>/send"), "GET / did not return send usage");
assert(root.text.includes(`${baseUrl}/a | sh`), "GET / did not return bootstrap usage");
assert(!root.text.includes("/probe"), "GET / should not document probe");
assert(!root.text.includes("/config"), "GET / should not document config");
assert(!root.text.includes("WebRTC"), "GET / should not document WebRTC");

const legacy = await request("/connect.sh");
assert(legacy.response.status === 404, `legacy connect.sh should be disabled, got ${legacy.response.status}`);

const bootstrap = await request("/a");
assert(bootstrap.response.ok, `GET /a returned ${bootstrap.response.status}: ${bootstrap.text}`);
assert(bootstrap.text.includes("sh \"$AGENT_FILE\""), "POSIX bootstrap does not run the relay agent");
assert(!bootstrap.text.includes("SOE_NATIVE"), "POSIX bootstrap still includes native path");
assert(!bootstrap.text.includes("SOE_AUTO_UPGRADE"), "POSIX bootstrap still includes auto-upgrade path");

const psBootstrap = await request("/a.ps1");
assert(psBootstrap.response.ok, `GET /a.ps1 returned ${psBootstrap.response.status}: ${psBootstrap.text}`);
assert(psBootstrap.text.includes("api/sessions.ps1"), "PowerShell bootstrap does not fetch the relay agent");
assert(!psBootstrap.text.includes("SOE_NATIVE"), "PowerShell bootstrap still includes native path");

const session = await request("/api/sessions", {
  method: "POST"
});
assert(session.response.ok, `POST /api/sessions returned ${session.response.status}: ${session.text}`);

const id = session.response.headers["x-session-id"];
assert(isSessionCode(id), "session code header missing");
assert(session.text.startsWith("#!/bin/sh"), "session response is not a shell script");
assert(session.text.includes(`/api/sessions/$SESSION_ID/next`), "shell script does not poll the session route");
assert(session.text.includes("AGENT_VERSION='0.3.0'"), "shell script has wrong agent version");
assert(!session.text.includes("download_native"), "shell script still contains native download");
assert(!session.text.includes("download_webrtc"), "shell script still contains WebRTC download");
assert(!session.text.includes("probe_json"), "shell script still contains probe control");
assert(!session.text.includes("config_json"), "shell script still contains config control");
assert(!session.text.includes("Authorization"), "shell script should not use authorization headers");
assert(!session.text.includes("?token" + "="), "shell script leaks token in URL");

const powerShell = await request("/api/sessions.ps1", {
  method: "POST"
});
assert(powerShell.response.ok, `POST /api/sessions.ps1 returned ${powerShell.response.status}: ${powerShell.text}`);
const powerShellId = powerShell.response.headers["x-session-id"];
assert(isSessionCode(powerShellId), "PowerShell session code header missing");
assert(powerShell.text.includes(`$SessionId = "${powerShellId}"`), "PowerShell script does not embed its session id");
assert(powerShell.text.includes("/api/sessions/$SessionId/next"), "PowerShell script does not poll the session route");
assert(powerShell.text.includes("$AgentVersion = \"0.3.0\""), "PowerShell script has wrong agent version");
assert(!powerShell.text.includes("Get-ProbeJson"), "PowerShell script still contains probe control");
assert(!powerShell.text.includes("Get-ConfigJson"), "PowerShell script still contains config control");
assert(!powerShell.text.includes("soe-webrtc"), "PowerShell script still contains WebRTC");
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

for (const removed of ["/probe", "/config", "/ice", "/signals"]) {
  const removedRoute = await request(`/api/sessions/${id}${removed}`, {
    method: removed === "/config" || removed === "/signals" ? "POST" : "GET"
  });
  assert(removedRoute.response.status === 404, `${removed} should be removed, got ${removedRoute.response.status}`);
}

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

console.log(`production smoke passed for ${baseUrl}`);
