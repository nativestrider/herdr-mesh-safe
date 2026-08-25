import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControllerLeaseStore, LeaseStore } from "../src/lease-store.js";
import { createCompositeTools } from "../src/tools/composite.js";
import { assertControllerAuthority, createSafeControllerTools } from "../src/tools/safe-controller.js";

const stateDir = await mkdtemp(join(tmpdir(), "herdr-mesh-controller-test-"));
try {
  const store = new ControllerLeaseStore(stateDir);
  let agents = [{
    agent: "codex",
    agent_status: "working",
    cwd: "/control/example",
    name: "example_coordinator",
    pane_id: "w1:p1",
    state_change_seq: 10,
  }];
  const relayCalls: string[][] = [];
  const run = async (args: string[]) => {
    if (args[0] === "agent" && args[1] === "list") {
      return { json: { result: { agents } }, stdout: "", stderr: "" };
    }
    relayCalls.push(args);
    return { json: { result: { ok: true } }, stdout: "", stderr: "" };
  };
  let now = new Date("2026-08-25T10:00:00.000Z");
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  ];
  const dependencies = {
    run,
    store,
    now: () => now,
    uuid: () => ids.shift() ?? "77777777-7777-4777-8777-777777777777",
    callerPaneId: "w1:p1",
  };
  const tools = createSafeControllerTools(dependencies);
  const acquire = tools.find((tool) => tool.name === "herdr_controller_acquire");
  const resume = tools.find((tool) => tool.name === "herdr_controller_resume");
  const list = tools.find((tool) => tool.name === "herdr_controller_list");
  assert(acquire?.run && resume?.run && list?.run);

  const acquiredResult = await acquire.run({
    controller_id: "example",
    authority_ref: "https://example.test/spec",
    authority_sha256: "a".repeat(64),
    ttl_seconds: 60,
  });
  const acquired = JSON.parse(acquiredResult.content[0].text).lease;
  assert.equal(acquired.paneId, "w1:p1");
  assert.equal(acquired.leaseId, "11111111-1111-4111-8111-111111111111");
  assert.equal(acquired.fenceToken, "22222222-2222-4222-8222-222222222222");
  await assert.rejects(
    assertControllerAuthority(dependencies, "example", acquired.leaseId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    /credentials do not match/,
  );
  const visible = JSON.parse((await list.run({})).content[0].text).leases[0];
  assert.equal("fenceToken" in visible, false);

  const composite = createCompositeTools({ run, controller: dependencies });
  const relay = composite.find((tool) => tool.name === "herdr_relay");
  assert(relay?.run);
  await relay.run({
    controller_id: "example",
    controller_lease_id: acquired.leaseId,
    controller_fence_token: acquired.fenceToken,
    target: "worker",
    text: "Continue",
  });
  assert.deepEqual(relayCalls.at(-1), [
    "agent", "prompt", "worker", "Continue", "--wait", "--until", "working", "--timeout", "5000",
  ]);

  const reviewerStore = new LeaseStore(stateDir);
  await reviewerStore.create({
    version: 1,
    leaseId: "88888888-8888-4888-8888-888888888888",
    controllerId: "example",
    purpose: "review",
    parentPaneId: "w1:p1",
    paneId: "w1:p3",
    agentName: "leased-reviewer",
    agentKind: "claude",
    cwd: "/review",
    state: "closing",
    createdAt: now.toISOString(),
  });
  const guardedComposite = createCompositeTools({
    run,
    controller: dependencies,
    leaseStores: [reviewerStore],
  });
  const guardedRelay = guardedComposite.find((tool) => tool.name === "herdr_relay");
  assert(guardedRelay?.run);
  await assert.rejects(guardedRelay.run({
    controller_id: "example",
    controller_lease_id: acquired.leaseId,
    controller_fence_token: acquired.fenceToken,
    target: "leased-reviewer",
    text: "Do not deliver",
  }), /refusing a new prompt during lifecycle transition/);
  assert.equal(relayCalls.some((args) => args.includes("leased-reviewer")), false);

  let releaseCompetingTransition: (() => void) | undefined;
  const competingTransition = new Promise<void>((resolve) => { releaseCompetingTransition = resolve; });
  const concurrentLease = {
    agentName: "concurrent-reviewer",
    controllerId: "example",
    state: "active",
  };
  const concurrentStore = {
    async list() { return [concurrentLease]; },
    async withExclusiveReservation<T>(operation: () => Promise<T>) {
      await competingTransition;
      return operation();
    },
  };
  const concurrentComposite = createCompositeTools({
    run,
    controller: dependencies,
    leaseStores: [concurrentStore],
  });
  const concurrentRelay = concurrentComposite.find((tool) => tool.name === "herdr_relay");
  assert(concurrentRelay?.run);
  const concurrentResult = concurrentRelay.run({
    controller_id: "example",
    controller_lease_id: acquired.leaseId,
    controller_fence_token: acquired.fenceToken,
    target: "concurrent-reviewer",
    text: "Do not race close",
  });
  concurrentLease.state = "closing";
  releaseCompetingTransition?.();
  await assert.rejects(concurrentResult, /refusing a new prompt during lifecycle transition/);
  assert.equal(relayCalls.some((args) => args.includes("concurrent-reviewer")), false);
  const concurrentHandoff = concurrentComposite.find((tool) => tool.name === "herdr_handoff");
  assert(concurrentHandoff?.run);
  await assert.rejects(concurrentHandoff.run({
    controller_id: "example",
    controller_lease_id: acquired.leaseId,
    controller_fence_token: acquired.fenceToken,
    target: "concurrent-reviewer",
    message: "Do not bypass the lifecycle guard",
    timeout_ms: 5000,
  }), /refusing a new prompt during lifecycle transition/);

  now = new Date("2026-08-25T10:00:30.000Z");
  const resumed = JSON.parse((await resume.run({
    controller_id: "example",
    authority_ref: "https://example.test/spec",
    authority_sha256: "b".repeat(64),
    ttl_seconds: 60,
  })).content[0].text).lease;
  assert.equal(resumed.generation, 2);
  assert.equal(resumed.predecessorLeaseId, acquired.leaseId);
  await assert.rejects(
    assertControllerAuthority(dependencies, "example", acquired.leaseId, acquired.fenceToken),
    /credentials do not match/,
  );

  now = new Date("2026-08-25T10:02:00.000Z");
  agents = [
    { ...agents[0], agent_status: "done" },
    {
      agent: "claude",
      agent_status: "working",
      cwd: "/control/example",
      name: "example_claude_coordinator",
      pane_id: "w1:p2",
      state_change_seq: 11,
    },
  ];
  const takeoverTools = createSafeControllerTools({ ...dependencies, callerPaneId: "w1:p2" });
  const takeover = takeoverTools.find((tool) => tool.name === "herdr_controller_takeover");
  assert(takeover?.run);
  const successor = JSON.parse((await takeover.run({
    controller_id: "example",
    expected_predecessor_lease_id: resumed.leaseId,
    authority_ref: "https://example.test/spec#checkpoint",
    authority_sha256: "c".repeat(64),
    ttl_seconds: 60,
  })).content[0].text).lease;
  assert.equal(successor.agentKind, "claude");
  assert.equal(successor.paneId, "w1:p2");
  assert.equal(successor.generation, 3);
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("safe controller lease contract passed");
