import assert from "node:assert/strict";
import { buildHandoffPromptArgs, buildRelayArgs } from "../src/tools/composite.js";
const { agentTools } = await import("../src/tools/agent.js");

const agentWait = agentTools.find((tool) => tool.name === "herdr_agent_wait");
const waitOutput = agentTools.find((tool) => tool.name === "herdr_wait_output");
assert(agentWait?.buildArgs && waitOutput?.buildArgs);

assert.deepEqual(buildRelayArgs("conference_type", "hello"), [
  "agent", "prompt", "conference_type", "hello",
]);
assert.deepEqual(buildHandoffPromptArgs("conference_type", "review", "idle", 5000), [
  "agent", "prompt", "conference_type", "review", "--wait", "--timeout", "5000",
]);
assert.deepEqual(buildHandoffPromptArgs("conference_type", "review", "blocked", 5000), [
  "agent", "prompt", "conference_type", "review", "--wait", "--until", "blocked", "--timeout", "5000",
]);
assert.deepEqual(agentWait.buildArgs({ target: "conference_type", status: "idle", timeout_ms: 5000 }), [
  "agent", "wait", "conference_type", "--until", "idle", "--timeout", "5000",
]);
assert.deepEqual(waitOutput.buildArgs({ pane_id: "w1:p1", match: "PASS", timeout_ms: 5000 }), [
  "pane", "wait-output", "w1:p1", "--match", "PASS", "--timeout", "5000",
]);

console.log("herdr CLI contract passed");
