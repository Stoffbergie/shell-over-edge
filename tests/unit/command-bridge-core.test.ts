import { test } from "vitest";
import { strict as assert } from "node:assert";
import { CommandBridgeCore } from "../../src/worker/durable-objects/command-bridge-core";

console.info = () => {};

test("matches parallel command results by command id", async () => {
  const bridge = new CommandBridgeCore();
  const first = sendCommand(bridge, { body: "printf one", cwd: "/tmp", timeoutSeconds: 10 });
  const second = sendCommand(bridge, { body: "printf two", timeoutSeconds: 10 });

  const firstCommand = await nextCommand(bridge);
  const secondCommand = await nextCommand(bridge);
  assert.equal(firstCommand.body, "printf one");
  assert.equal(Buffer.from(firstCommand.cwd || "", "base64").toString("utf8"), "/tmp");
  assert.equal(secondCommand.body, "printf two");

  assert.equal((await postResult(bridge, secondCommand.id, "two", 0)).status, 200);
  assert.equal((await postResult(bridge, firstCommand.id, "one", 7)).status, 200);

  const firstResponse = await first;
  const secondResponse = await second;
  assert.equal(firstResponse.status, 500);
  assert.equal(firstResponse.headers.get("X-Exit-Code"), "7");
  assert.equal(await firstResponse.text(), "one");
  assert.equal(secondResponse.status, 200);
  assert.equal(secondResponse.headers.get("X-Exit-Code"), "0");
  assert.equal(await secondResponse.text(), "two");
});

test("end resolves pending polls and sends", async () => {
  const pollBridge = new CommandBridgeCore();
  const pendingPoll = pollBridge.fetch(new Request("https://session/next"));
  const pollEnd = await pollBridge.fetch(new Request("https://session/end", { method: "POST" }));
  assert.equal(pollEnd.status, 200);
  assert.equal(await pollEnd.text(), "ended\n");
  const pollResponse = await pendingPoll;
  assert.equal(pollResponse.status, 410);
  assert.equal(await pollResponse.text(), "Session ended\n");

  const sendBridge = new CommandBridgeCore();
  const pendingSend = sendCommand(sendBridge, { body: "queued", timeoutSeconds: 10 });
  await sleep(0);
  const sendEnd = await sendBridge.fetch(new Request("https://session/end", { method: "POST" }));
  assert.equal(sendEnd.status, 200);
  assert.equal(await sendEnd.text(), "ended\n");
  const sendResponse = await pendingSend;
  assert.equal(sendResponse.status, 410);
  assert.equal(await sendResponse.text(), "Session ended\n");
});

test("acknowledges late known results after command timeout", async () => {
  const bridge = new CommandBridgeCore();
  const send = sendCommand(bridge, { body: "slow", timeoutSeconds: 1 });
  const command = await nextCommand(bridge);
  assert.equal(command.body, "slow");

  await sleep(2200);

  const timedOut = await send;
  assert.equal(timedOut.status, 504);
  assert.equal(await timedOut.text(), "Timed out waiting for command result\n");

  const late = await postResult(bridge, command.id, "late", 0);
  assert.equal(late.status, 200);
  assert.equal(await late.text(), "ok\n");

  const missing = await postResult(bridge, "missing", "nope", 0);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Command not found\n");
});

function sendCommand(bridge: CommandBridgeCore, body: { body: string; cwd?: string; timeoutSeconds?: number }): Promise<Response> {
  return bridge.fetch(new Request("https://session/send", {
    method: "POST",
    body: JSON.stringify(body)
  }));
}

async function nextCommand(bridge: CommandBridgeCore): Promise<{ id: string; body: string; cwd: string }> {
  const response = await bridge.fetch(new Request("https://session/next"));
  assert.equal(response.status, 200);
  const id = response.headers.get("X-Command-Id") || "";
  assert.ok(id);
  return {
    id,
    body: await response.text(),
    cwd: response.headers.get("X-Command-Cwd-Base64") || ""
  };
}

function postResult(bridge: CommandBridgeCore, commandId: string, body: string, exitCode: number): Promise<Response> {
  return bridge.fetch(new Request(`https://session/result/${commandId}?exit=${exitCode}`, {
    method: "POST",
    body
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
