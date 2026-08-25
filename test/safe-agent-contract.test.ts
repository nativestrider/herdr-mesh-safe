import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentStartArgs,
  buildPaneCloseArgs,
  buildPaneSplitArgs,
  buildSettledWaitArgs,
  createSafeAgentTools,
  extractAgentSnapshot,
  extractAgentSnapshots,
} from "../src/tools/safe-agent.js";
import { LeaseStore, type ReviewerLease } from "../src/lease-store.js";

assert.deepEqual(buildSettledWaitArgs("reviewer", 5000), [
  "agent", "wait", "reviewer", "--timeout", "5000",
]);
assert.deepEqual(buildPaneSplitArgs("w1:p1", "right", "/work/repo"), [
  "pane", "split", "w1:p1", "--direction", "right", "--cwd", "/work/repo", "--no-focus",
]);
assert.deepEqual(buildAgentStartArgs("reviewer", "claude", "w1:p2", 30000), [
  "agent", "start", "reviewer", "--kind", "claude", "--pane", "w1:p2", "--timeout", "30000",
]);
assert.deepEqual(buildPaneCloseArgs("w1:p2"), ["pane", "close", "w1:p2"]);

assert.deepEqual(
  extractAgentSnapshot({
    result: {
      agent: {
        agent: "claude",
        agent_status: "idle",
        cwd: "/work/repo",
        name: "reviewer",
        pane_id: "w1:p2",
        state_change_seq: 42,
      },
    },
  }),
  {
    target: "reviewer",
    kind: "claude",
    status: "idle",
    cwd: "/work/repo",
    name: "reviewer",
    paneId: "w1:p2",
    stateChangeSeq: 42,
  },
);
assert.equal(extractAgentSnapshots({ result: { agents: [
  { agent: "codex", agent_status: "working", cwd: "/a", name: "a", pane_id: "w1:p1", state_change_seq: 1 },
  { agent: "claude", agent_status: "idle", cwd: "/b", name: "b", pane_id: "w1:p2", state_change_seq: 2 },
] } }).length, 2);

const stateDir = await mkdtemp(join(tmpdir(), "herdr-mesh-lease-test-"));
try {
  const store = new LeaseStore(stateDir);
  const lease: ReviewerLease = {
    version: 1,
    leaseId: "11111111-1111-4111-8111-111111111111",
    controllerId: "example-control",
    purpose: "Review ticket 85",
    parentPaneId: "w1:p1",
    paneId: "w1:p2",
    agentName: "reviewer",
    agentKind: "claude",
    cwd: "/work/repo",
    state: "active",
    createdAt: "2026-08-25T10:00:00.000Z",
  };
  await store.create(lease);
  assert.deepEqual(await store.get(lease.leaseId), lease);
  assert.deepEqual(await store.list("example-control"), [lease]);

  const closed = { ...lease, state: "closed" as const, closedAt: "2026-08-25T10:10:00.000Z" };
  await store.update(closed);
  assert.deepEqual(await store.get(lease.leaseId), closed);

  const waitCalls: string[][] = [];
  const waitStates = [
    { agent_status: "idle", state_change_seq: 5 },
    { agent_status: "working", state_change_seq: 6 },
    { agent_status: "done", state_change_seq: 7 },
  ];
  const waitRun = async (args: string[]) => {
    waitCalls.push(args);
    if (args[0] === "agent" && args[1] === "get") {
      const state = waitStates.shift();
      assert(state);
      return {
        json: { result: { agent: {
          agent: "codex",
          cwd: stateDir,
          name: "cursor-reviewer",
          pane_id: "w1:p8",
          ...state,
        } } },
        stdout: "",
        stderr: "",
      };
    }
    if (args[0] === "agent" && args[1] === "wait") {
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "read") {
      return { stdout: "new result", stderr: "" };
    }
    throw new Error(`unexpected wait call: ${args.join(" ")}`);
  };
  const waitTools = createSafeAgentTools({
    run: waitRun,
    store,
    now: () => new Date("2026-08-25T10:30:00.000Z"),
    uuid: () => "33333333-3333-4333-8333-333333333333",
  });
  const settledTool = waitTools.find((tool) => tool.name === "herdr_agent_wait_settled");
  assert(settledTool?.run);
  const settled = await settledTool.run({ target: "cursor-reviewer", after_seq: 5, timeout_ms: 5000 });
  const settledPayload = JSON.parse(settled.content[0].text) as { agent: { status: string; stateChangeSeq: number } };
  assert.equal(settledPayload.agent.status, "done");
  assert.equal(settledPayload.agent.stateChangeSeq, 7);
  assert(waitCalls.some((args) => args.includes("--until") && args.includes("working")));
  assert(waitCalls.some((args) => args[0] === "agent" && args[1] === "wait" && !args.includes("--until")));

  const runtimeStore = new LeaseStore(join(stateDir, "runtime"));
  const calls: string[][] = [];
  let paneClosed = false;
  const fakeRun = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "split") {
      return { json: { result: { pane: { pane_id: "w1:p9" } } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "start") {
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "get") {
      return {
        json: { result: { agent: {
          agent: "claude",
          agent_status: "idle",
          cwd: stateDir,
          name: "leased-reviewer",
          pane_id: "w1:p9",
          state_change_seq: 9,
        } } },
        stdout: "",
        stderr: "",
      };
    }
    if (args[0] === "agent" && args[1] === "read") {
      return { stdout: "review complete", stderr: "" };
    }
    if (args[0] === "pane" && args[1] === "close" && args[2] === "w1:p9") {
      paneClosed = true;
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected fake Herdr call: ${args.join(" ")}`);
  };
  const tools = createSafeAgentTools({
    run: fakeRun,
    store: runtimeStore,
    now: () => new Date("2026-08-25T11:00:00.000Z"),
    uuid: () => "22222222-2222-4222-8222-222222222222",
  });
  const startTool = tools.find((tool) => tool.name === "herdr_owned_reviewer_start");
  const closeTool = tools.find((tool) => tool.name === "herdr_owned_reviewer_close");
  assert(startTool?.run && closeTool?.run);
  await startTool.run({
    controller_id: "example-control",
    purpose: "Review ticket 85",
    parent_pane_id: "w1:p1",
    cwd: stateDir,
    name: "leased-reviewer",
    kind: "claude",
  });
  assert.equal((await runtimeStore.get("22222222-2222-4222-8222-222222222222")).state, "active");
  await closeTool.run({
    lease_id: "22222222-2222-4222-8222-222222222222",
    controller_id: "example-control",
  });
  const captured = await runtimeStore.get("22222222-2222-4222-8222-222222222222");
  assert.equal(captured.state, "closed");
  assert.equal(captured.captureSha256, "c121c65cdeeb09f7a402f6067f7d3fe5cb4d58a662fcb1cf5a943f6431a9dffe");
  assert.equal(paneClosed, true);
  assert(calls.some((args) => args.join(" ") === "pane close w1:p9"));
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("safe Herdr agent contract passed");
