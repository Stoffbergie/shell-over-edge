const baseUrl = (process.env.SOE_BASE_URL || process.argv.find((arg) => arg.startsWith("--base-url="))?.slice("--base-url=".length) || "https://soe.stoff.dev").replace(/\/$/, "");

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  return { response, text };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = await request("/");
assert(root.response.ok, `GET / returned ${root.response.status}`);
assert(root.text.includes("soe"), "GET / did not return soe usage");

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

console.log(`production smoke passed for ${baseUrl}`);
