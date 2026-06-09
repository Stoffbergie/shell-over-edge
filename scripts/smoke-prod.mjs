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
            status
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

const legacy = await request("/connect.sh");
assert(legacy.response.status === 404, `legacy connect.sh should be disabled, got ${legacy.response.status}`);

const session = await request("/api/sessions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ helperName: "smoke" })
});
assert(session.response.ok, `POST /api/sessions returned ${session.response.status}: ${session.text}`);

const payload = JSON.parse(session.text);
assert(typeof payload.id === "string" && payload.id.startsWith("sess_"), "session id missing");
assert(typeof payload.code === "string" && payload.code.startsWith("BR-"), "session code missing");
assert(typeof payload.helperToken === "string" && payload.helperToken.length >= 32, "helper token missing");
assert(typeof payload.agentToken === "string" && payload.agentToken.length >= 32, "agent token missing");
assert(payload.shellCommand.includes("https://soe.stoff.dev/start/"), "shell command points at the wrong host");
assert(!payload.shellCommand.includes("?token" + "="), "shell command leaks token in URL");
assert(payload.windowsCommand.includes("https://soe.stoff.dev/start/"), "windows command points at the wrong host");
assert(!payload.windowsCommand.includes("?token" + "="), "windows command leaks token in URL");

const unauthorized = await request(`/api/sessions/${payload.id}`);
assert(unauthorized.response.status === 401, `unauthorized session read should be 401, got ${unauthorized.response.status}`);

const authed = await request(`/api/sessions/${payload.id}`, {
  headers: { Authorization: `Bearer ${payload.helperToken}` }
});
assert(authed.response.ok, `authorized session read returned ${authed.response.status}: ${authed.text}`);

const ended = await request(`/api/sessions/${payload.id}/end`, {
  method: "POST",
  headers: { Authorization: `Bearer ${payload.helperToken}` }
});
assert(ended.response.ok, `session end returned ${ended.response.status}: ${ended.text}`);
const endedPayload = JSON.parse(ended.text);
assert(endedPayload.ok === true && endedPayload.status === "ended", "session end payload is wrong");

console.log(`production smoke passed for ${baseUrl}`);
