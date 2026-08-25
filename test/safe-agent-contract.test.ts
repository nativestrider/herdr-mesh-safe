import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentStartArgs,
  buildPaneCloseArgs,
  buildTabCreateArgs,
  buildSettledWaitArgs,
  createSafeAgentTools,
  extractAgentSnapshot,
  extractAgentSnapshots,
  startAgentWhenShellReady,
} from "../src/tools/safe-agent.js";
import { ControllerLeaseStore, LeaseStore, type ControllerLease, type ReviewerLease } from "../src/lease-store.js";

assert.deepEqual(buildSettledWaitArgs("reviewer", 5000), [
  "agent", "wait", "reviewer", "--timeout", "5000",
]);
assert.deepEqual(buildTabCreateArgs("w1", "/work/repo", "reviewer"), [
  "tab", "create", "--workspace", "w1", "--cwd", "/work/repo", "--label", "reviewer", "--no-focus",
]);
assert.deepEqual(buildAgentStartArgs("reviewer", "claude", "w1:p2", 30000), [
  "agent", "start", "reviewer", "--kind", "claude", "--pane", "w1:p2", "--timeout", "30000",
]);
assert.deepEqual(buildAgentStartArgs("reviewer", "claude", "w1:p2", 30000, "opus", "xhigh"), [
  "agent", "start", "reviewer", "--kind", "claude", "--pane", "w1:p2", "--timeout", "30000",
  "--", "--model", "opus", "--effort", "xhigh",
]);
assert.deepEqual(buildPaneCloseArgs("w1:p2"), ["pane", "close", "w1:p2"]);

const forwardedStartTimeouts: number[] = [];
await startAgentWhenShellReady(
  async (args) => {
    forwardedStartTimeouts.push(Number(args[args.indexOf("--timeout") + 1]));
    return { json: { result: { ok: true } }, stdout: "", stderr: "" };
  },
  "full-budget-reviewer",
  "claude",
  "w1:p29",
  30_000,
  undefined,
  undefined,
  async () => {},
  () => 0,
);
assert.deepEqual(forwardedStartTimeouts, [30_000]);

let minimumClock = 0;
let minimumAttempts = 0;
await startAgentWhenShellReady(
  async (args) => {
    minimumAttempts += 1;
    assert(Number(args[args.indexOf("--timeout") + 1]) > 3_000);
    return { json: { result: { ok: true } }, stdout: "", stderr: "" };
  },
  "minimum-budget-reviewer",
  "claude",
  "w1:p30",
  3_001,
  undefined,
  undefined,
  async () => {},
  () => { minimumClock += 1; return minimumClock; },
);
assert.equal(minimumAttempts, 1);

let retryClock = 0;
let retryAttempts = 0;
await assert.rejects(
  startAgentWhenShellReady(
    async () => {
      retryAttempts += 1;
      retryClock += 250;
      throw new Error('{"error":{"code":"agent_pane_busy"}}');
    },
    "bounded-reviewer",
    "claude",
    "w1:p30",
    1_000,
    undefined,
    undefined,
    async (milliseconds) => { retryClock += milliseconds; },
    () => retryClock,
  ),
  /agent_pane_busy/,
);
assert(retryAttempts <= 4, `expected a bounded retry count, got ${retryAttempts}`);

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

  const controllerStore = new ControllerLeaseStore(join(stateDir, "controller"));
  const controllerLease: ControllerLease = {
    version: 1,
    leaseType: "controller",
    leaseId: "99999999-9999-4999-8999-999999999999",
    controllerId: "example-control",
    fenceToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 1,
    authorityRef: "https://example.test/spec",
    authoritySha256: "a".repeat(64),
    paneId: "w1:p1",
    agentName: "controller",
    agentKind: "codex",
    cwd: stateDir,
    state: "active",
    acquiredAt: "2026-08-25T09:00:00.000Z",
    renewedAt: "2026-08-25T09:00:00.000Z",
    expiresAt: "2026-08-25T12:00:00.000Z",
  };
  await controllerStore.create(controllerLease);
  const controller = {
    store: controllerStore,
    now: () => new Date("2026-08-25T11:00:00.000Z"),
    callerPaneId: "w1:p1",
  };

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
    controller,
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
  let startAttempts = 0;
  let outputRead = false;
  let changeAfterRead = true;
  const fakeRun = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "get") {
      return { json: { result: { pane: { pane_id: "w1:p1", workspace_id: "w1" } } }, stdout: "", stderr: "" };
    }
    if (args[0] === "tab" && args[1] === "create") {
      return { json: { result: { pane: { pane_id: "w1:p9" } } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "start") {
      startAttempts += 1;
      if (startAttempts === 1) throw new Error('{"error":{"code":"agent_pane_busy"}}');
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "get") {
      return {
        json: { result: { agent: {
          agent: "claude",
          agent_status: outputRead && changeAfterRead ? "working" : "idle",
          cwd: stateDir,
          name: "leased-reviewer",
          pane_id: "w1:p9",
          state_change_seq: outputRead && changeAfterRead ? 10 : 9,
        } } },
        stdout: "",
        stderr: "",
      };
    }
    if (args[0] === "agent" && args[1] === "read") {
      outputRead = true;
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
    controller,
    now: () => new Date("2026-08-25T11:00:00.000Z"),
    uuid: () => "22222222-2222-4222-8222-222222222222",
    pause: async () => {},
  });
  const startTool = tools.find((tool) => tool.name === "herdr_owned_reviewer_start");
  const closeTool = tools.find((tool) => tool.name === "herdr_owned_reviewer_close");
  assert(startTool?.run && closeTool?.run);
  assert.equal(startTool.inputSchema.start_timeout_ms.safeParse(3_000).success, false);
  assert.equal(startTool.inputSchema.start_timeout_ms.safeParse(3_001).success, true);
  await startTool.run({
    controller_id: "example-control",
    controller_lease_id: controllerLease.leaseId,
    controller_fence_token: controllerLease.fenceToken,
    purpose: "Review ticket 85",
    parent_pane_id: "w1:p1",
    cwd: stateDir,
    name: "leased-reviewer",
    kind: "claude",
  });
  assert.equal((await runtimeStore.get("22222222-2222-4222-8222-222222222222")).state, "active");
  await assert.rejects(closeTool.run({
    lease_id: "22222222-2222-4222-8222-222222222222",
    controller_id: "example-control",
    controller_lease_id: controllerLease.leaseId,
    controller_fence_token: controllerLease.fenceToken,
    expected_state_change_seq: 9,
  }), /state changed while capturing output/);
  assert.equal(paneClosed, false);
  assert.equal((await runtimeStore.get("22222222-2222-4222-8222-222222222222")).state, "active");

  outputRead = false;
  changeAfterRead = false;
  await closeTool.run({
    lease_id: "22222222-2222-4222-8222-222222222222",
    controller_id: "example-control",
    controller_lease_id: controllerLease.leaseId,
    controller_fence_token: controllerLease.fenceToken,
    expected_state_change_seq: 9,
  });
  const captured = await runtimeStore.get("22222222-2222-4222-8222-222222222222");
  assert.equal(captured.state, "closed");
  assert.equal(captured.captureSha256, "c121c65cdeeb09f7a402f6067f7d3fe5cb4d58a662fcb1cf5a943f6431a9dffe");
  assert.equal(paneClosed, true);
  assert.equal(startAttempts, 2);
  assert(calls.some((args) => args.join(" ") === "pane get w1:p1"));
  assert(calls.some((args) => args.join(" ") === `tab create --workspace w1 --cwd ${stateDir} --label leased-reviewer --no-focus`));
  assert.equal(calls.some((args) => args[0] === "pane" && args[1] === "split"), false);
  assert(calls.some((args) => args.join(" ") === "pane close w1:p9"));
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("safe Herdr agent contract passed");
