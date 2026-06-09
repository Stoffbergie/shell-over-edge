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

const root = await request("/");
assert(root.response.ok, `GET / returned ${root.response.status}`);
assert(root.text.includes("Shell Over Edge"), "GET / did not return Shell Over Edge usage");
assert(root.text.includes("/api/sessions/<uuid>/send"), "GET / did not return simplified send usage");

const legacy = await request("/connect.sh");
assert(legacy.response.status === 404, `legacy connect.sh should be disabled, got ${legacy.response.status}`);

const session = await request("/api/sessions", {
  method: "POST"
});
assert(session.response.ok, `POST /api/sessions returned ${session.response.status}: ${session.text}`);

const id = session.response.headers["x-session-id"];
assert(isUuidV4(id), "session id header missing");
assert(session.text.startsWith("#!/bin/sh"), "session response is not a shell script");
assert(session.text.includes(`/api/sessions/$SESSION_ID/next`), "shell script does not poll the simplified session route");
assert(!session.text.includes("Authorization"), "shell script should not use authorization headers");
assert(!session.text.includes("?token" + "="), "shell script leaks token in URL");

const powerShell = await request("/api/sessions.ps1", {
  method: "POST"
});
assert(powerShell.response.ok, `POST /api/sessions.ps1 returned ${powerShell.response.status}: ${powerShell.text}`);
const powerShellId = powerShell.response.headers["x-session-id"];
assert(isUuidV4(powerShellId), "PowerShell session id header missing");
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

function isUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value || "");
}

console.log(`production smoke passed for ${baseUrl}`);
