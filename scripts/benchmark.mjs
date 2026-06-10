import { lookup, resolve4 } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));

const baseUrl = (args.get("base-url") || process.env.SOE_BASE_URL || "https://soe.stoff.dev").replace(/\/$/, "");
const runs = positiveInt(args.get("runs"), 7);
const burst = positiveInt(args.get("burst"), 32);
const json = args.has("json");
const retryableDnsCodes = new Set(["ENOTFOUND", "EAI_AGAIN"]);

const timings = {
  bootstrap: [],
  relay: []
};
const sizes = {};

for (let index = 0; index < runs; index += 1) {
  let id = "";
  try {
    const bootstrap = await timed(() => request("/"));
    timings.bootstrap.push(bootstrap.ms);
    if (index === 0) sizes.bootstrap = bootstrap.result.bytes;
    id = bootstrap.result.headers["x-session-id"];
    assertSessionCode(id);

    await request(`/api/sessions/${id}/hello`, { method: "POST", body: process.cwd() });
    const relay = await timed(() => relayCommand(id, `printf benchmark-${index}`));
    timings.relay.push(relay.ms);
    if (relay.result.text !== `benchmark-${index}`) throw new Error(`Relay returned wrong output: ${relay.result.text}`);
  } finally {
    if (id) await endSession(id);
  }
}

const powerShell = await request("/a.ps1");
sizes.powerShellBootstrap = powerShell.bytes;
if (powerShell.headers["x-session-id"]) await endSession(powerShell.headers["x-session-id"]);

const burstSession = await request("/");
const burstId = burstSession.headers["x-session-id"];
assertSessionCode(burstId);
let burstResult;
try {
  await request(`/api/sessions/${burstId}/hello`, { method: "POST", body: process.cwd() });
  burstResult = await timed(() => relayBurst(burstId, burst));
} finally {
  await endSession(burstId);
}

const report = {
  baseUrl,
  measuredAt: new Date().toISOString(),
  runs,
  burst,
  timings: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, stats(values)])),
  burstResult: {
    totalMs: round(burstResult.ms),
    commands: burst,
    commandsPerSecond: round(burst / (burstResult.ms / 1000))
  },
  sizes
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
}

async function relayCommand(sessionId, body) {
  const send = request(`/api/sessions/${sessionId}/send?timeout=10`, {
    method: "POST",
    body: JSON.stringify({ body })
  });
  const command = await nextCommand(sessionId);
  await request(`/api/sessions/${sessionId}/result/${command.id}?exit=0`, {
    method: "POST",
    body: body.replace(/^printf /, "")
  });
  const result = await send;
  if (result.status !== 200) throw new Error(`Relay send failed ${result.status}: ${result.text}`);
  return result;
}

async function relayBurst(sessionId, count) {
  const sends = Array.from({ length: count }, (_, index) => {
    const body = `burst-${index}`;
    return request(`/api/sessions/${sessionId}/send?timeout=20`, {
      method: "POST",
      body: JSON.stringify({ body })
    }).then((response) => ({ body, response }));
  });

  const commands = [];
  for (let index = 0; index < count; index += 1) {
    commands.push(await nextCommand(sessionId));
  }

  await Promise.all(commands.map((command) => request(`/api/sessions/${sessionId}/result/${command.id}?exit=0`, {
    method: "POST",
    body: `done:${command.body}`
  })));

  const results = await Promise.all(sends);
  for (const item of results) {
    if (item.response.status !== 200) throw new Error(`Burst send failed ${item.response.status}: ${item.response.text}`);
    if (item.response.text !== `done:${item.body}`) throw new Error(`Burst mismatch: ${item.response.text}`);
  }
}

async function nextCommand(sessionId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request(`/api/sessions/${sessionId}/next`);
    if (response.status === 200) {
      const id = response.headers["x-command-id"];
      if (!id) throw new Error("Command id missing");
      return { id, body: response.text };
    }
    if (response.status !== 204) throw new Error(`Next returned ${response.status}: ${response.text}`);
    await sleep(25);
  }
  throw new Error("Timed out waiting for command");
}

async function endSession(sessionId) {
  await request(`/api/sessions/${sessionId}/end`, { method: "POST" }).catch(() => undefined);
}

async function timed(fn) {
  const startedAt = performance.now();
  const result = await fn();
  return { ms: performance.now() - startedAt, result };
}

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
      timeout: 20000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const status = response.statusCode || 0;
        resolve({
          bytes: bytes.byteLength,
          headers: response.headers,
          status,
          text: bytes.toString("utf8")
        });
      });
    });

    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error(`Request timed out after 20000ms: ${url.href}`)));
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

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: round(sorted[0]),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted[sorted.length - 1])
  };
}

function percentile(sorted, value) {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * value;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function printReport(report) {
  console.log(`Shell Over Edge benchmark`);
  console.log(`Base: ${report.baseUrl}`);
  console.log(`Measured: ${report.measuredAt}`);
  console.log(`Runs: ${report.runs}`);
  console.log("");
  console.log("| Metric | min ms | p50 ms | p95 ms | max ms |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const [name, value] of Object.entries(report.timings)) {
    console.log(`| ${name} | ${value.min} | ${value.p50} | ${value.p95} | ${value.max} |`);
  }
  console.log("");
  console.log(`Burst: ${report.burstResult.commands} commands in ${report.burstResult.totalMs} ms (${report.burstResult.commandsPerSecond}/s)`);
  console.log("");
  console.log("| Payload | bytes |");
  console.log("| --- | ---: |");
  for (const [name, value] of Object.entries(report.sizes)) {
    console.log(`| ${name} | ${value} |`);
  }
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((header) => header.toLowerCase() === name);
}

function assertSessionCode(value) {
  if (!/^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(value || "")) {
    throw new Error(`Invalid session code: ${value}`);
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value || fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
