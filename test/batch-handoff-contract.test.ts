import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControllerLeaseStore, type ControllerLease } from "../src/lease-store.js";
import { createCompositeTools } from "../src/tools/composite.js";

const stateDir = await mkdtemp(join(tmpdir(), "herdr-mesh-batch-handoff-test-"));

try {
  const controllerStore = new ControllerLeaseStore(join(stateDir, "controller"));
  const now = new Date("2026-08-25T10:00:00.000Z");
  const controller: ControllerLease = {
    version: 1,
    leaseType: "controller",
    leaseId: "11111111-1111-4111-8111-111111111111",
    controllerId: "example",
    fenceToken: "22222222-2222-4222-8222-222222222222",
    generation: 1,
    authorityRef: "project.toml",
    authoritySha256: "a".repeat(64),
    paneId: "w1:p1",
    agentName: "example_coordinator",
    agentKind: "codex",
    cwd: "/control/example",
    state: "active",
    acquiredAt: now.toISOString(),
    renewedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
  };
  await controllerStore.create(controller);

  let lockHeld = false;
  const workerLeases = ["worker-a", "worker-b"].map((agentName, index) => ({
    leaseId: index === 0
      ? "33333333-3333-4333-8333-333333333333"
      : "44444444-4444-4444-8444-444444444444",
    agentName,
    paneId: index === 0 ? "w1:p2" : "w1:p3",
    controllerId: controller.controllerId,
    state: "active",
  }));
  const nameForTarget = (target: string): string => ({
    "w1:p2": "worker-a",
    "w1:p3": "worker-b",
  })[target] ?? target;
  const workerStore = {
    async list() {
      return workerLeases;
    },
    async withExclusiveReservation<T>(operation: () => Promise<T>) {
      assert.equal(lockHeld, false, "the batch must acquire each lease-store reservation once");
      lockHeld = true;
      try {
        return await operation();
      } finally {
        lockHeld = false;
      }
    },
  };
  let irrelevantReservations = 0;
  const irrelevantStore = {
    async list() { return []; },
    async withExclusiveReservation<T>(_operation: () => Promise<T>): Promise<T> {
      irrelevantReservations += 1;
      throw new Error("an unrelated lifecycle store must not be reserved");
    },
  };

  const calls: string[][] = [];
  const prompted = new Set<string>();
  const run = async (args: string[]) => {
    calls.push(args);
    const target = nameForTarget(args[2]);
    assert.equal(lockHeld, true, `${args[0]} ${args[1]} must remain inside the lifecycle reservation`);
    if (args[0] === "agent" && args[1] === "prompt") {
      prompted.add(target);
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "wait") {
      assert.deepEqual([...prompted].sort(), ["worker-a", "worker-b"], "fan-out must finish before collection starts");
      return { json: { result: { agent_status: "idle", state_change_seq: target === "worker-a" ? 11 : 12 } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "get") {
      return {
        json: {
          result: {
            agent: {
              agent: "codex",
              agent_status: "idle",
              cwd: `/work/${target}`,
              name: target,
              pane_id: target === "worker-a" ? "w1:p2" : "w1:p3",
              state_change_seq: target === "worker-a" ? 11 : 12,
            },
          },
        },
        stdout: "",
        stderr: "",
      };
    }
    if (args[0] === "agent" && args[1] === "read") {
      return { stdout: `output-${target}`, stderr: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };

  const tools = createCompositeTools({
    run,
    controller: { store: controllerStore, now: () => now, callerPaneId: controller.paneId },
    leaseStores: [workerStore, irrelevantStore],
  });
  const batch = tools.find((tool) => tool.name === "herdr_batch_handoff");
  assert(batch?.run, "the public herdr_batch_handoff tool must exist");

  const result = await batch.run({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    mode: "all",
    requests: [
      { target: "worker-a", message: "Review standards" },
      { target: "worker-b", message: "Review the spec" },
    ],
    timeout_ms: 5_000,
    read_lines: 80,
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.mode, "all");
  assert.deepEqual(payload.pendingTargets, []);
  assert.deepEqual(payload.completed.map((entry: { target: string }) => entry.target), ["worker-a", "worker-b"]);
  assert.deepEqual(payload.completed.map((entry: { output: string }) => entry.output), ["output-worker-a", "output-worker-b"]);
  assert.equal(calls.filter((args) => args[1] === "prompt").length, 2);
  assert.equal(calls.filter((args) => args[1] === "wait").length, 2);
  assert.deepEqual(calls.filter((args) => args[1] === "prompt").map((args) => args[2]), ["w1:p2", "w1:p3"]);
  assert.equal(irrelevantReservations, 0);

  let losingWaitAborted = false;
  const signalledCommands: string[] = [];
  const firstRun = async (
    args: string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => {
    const target = nameForTarget(args[2]);
    if (options?.signal) signalledCommands.push(`${args[1]}:${target}`);
    assert.equal(lockHeld, true, `${args[0]} ${args[1]} must remain inside the lifecycle reservation`);
    if (args[0] === "agent" && args[1] === "prompt") {
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "wait") {
      if (target === "worker-a") {
        return { json: { result: { agent_status: "idle" } }, stdout: "", stderr: "" };
      }
      return new Promise<{ json: { result: { agent_status: string } }; stdout: string; stderr: string }>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve({ json: { result: { agent_status: "idle" } }, stdout: "", stderr: "" }),
          10,
        );
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          losingWaitAborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    }
    if (args[0] === "agent" && args[1] === "get") {
      if (target === "worker-a") {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      return {
        json: {
          result: {
            agent: {
              agent: "codex",
              agent_status: "idle",
              cwd: `/work/${target}`,
              name: target,
              pane_id: "w1:p2",
              state_change_seq: 21,
            },
          },
        },
        stdout: "",
        stderr: "",
      };
    }
    if (args[0] === "agent" && args[1] === "read") {
      return { stdout: `first-output-${target}`, stderr: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const firstBatch = createCompositeTools({
    run: firstRun,
    controller: { store: controllerStore, now: () => now, callerPaneId: controller.paneId },
    leaseStores: [workerStore, irrelevantStore],
  }).find((tool) => tool.name === "herdr_batch_handoff");
  assert(firstBatch?.run);
  const firstResult = await firstBatch.run({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    mode: "first",
    requests: [
      { target: "worker-a", message: "Return first" },
      { target: "worker-b", message: "Continue independently" },
    ],
    timeout_ms: 5_000,
  });
  const firstPayload = JSON.parse(firstResult.content[0].text);
  assert.deepEqual(firstPayload.completed.map((entry: { target: string }) => entry.target), ["worker-a"]);
  assert.deepEqual(firstPayload.pendingTargets, ["worker-b"]);
  assert.equal(losingWaitAborted, true, "the losing CLI wait must be cancelled without stopping its worker");
  assert.deepEqual(signalledCommands.sort(), ["wait:worker-a", "wait:worker-b"], "only wait commands may be cancelled");

  let delayedCollectionFinished = false;
  const partialCollectionRun = async (args: string[]) => {
    const target = nameForTarget(args[2]);
    assert.equal(lockHeld, true, `${args[0]} ${args[1]} must remain inside the lifecycle reservation`);
    if (args[0] === "agent" && args[1] === "prompt") {
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "wait") {
      if (target === "worker-a") throw new Error("private worker-a failure detail");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      delayedCollectionFinished = true;
      return { json: { result: { agent_status: "idle" } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "get") {
      return {
        json: {
          result: {
            agent: {
              agent: "codex",
              agent_status: "idle",
              cwd: `/work/${target}`,
              name: target,
              pane_id: "w1:p3",
              state_change_seq: 31,
            },
          },
        },
        stdout: "",
        stderr: "",
      };
    }
    if (args[0] === "agent" && args[1] === "read") {
      return { stdout: `partial-output-${target}`, stderr: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const partialBatch = createCompositeTools({
    run: partialCollectionRun,
    controller: { store: controllerStore, now: () => now, callerPaneId: controller.paneId },
    leaseStores: [workerStore, irrelevantStore],
  }).find((tool) => tool.name === "herdr_batch_handoff");
  assert(partialBatch?.run);
  const partialResult = await partialBatch.run({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    mode: "all",
    requests: [
      { target: "worker-a", message: "May fail" },
      { target: "worker-b", message: "Must still be collected" },
    ],
    timeout_ms: 5_000,
  });
  const partialPayload = JSON.parse(partialResult.content[0].text);
  assert.equal(delayedCollectionFinished, true, "all in-flight collection must finish before reservations are released");
  assert.deepEqual(partialPayload.completed.map((entry: { target: string }) => entry.target), ["worker-b"]);
  assert.deepEqual(partialPayload.failed, [{ target: "worker-a", stage: "collection", error: "collection_failed" }]);
  assert.deepEqual(partialPayload.pendingTargets, ["worker-a"]);
  assert.doesNotMatch(partialResult.content[0].text, /private worker-a failure detail/);

  const deliveryFailureRun = async (args: string[]) => {
    assert.equal(lockHeld, true, `${args[0]} ${args[1]} must remain inside the lifecycle reservation`);
    if (args[0] === "agent" && args[1] === "prompt" && nameForTarget(args[2]) === "worker-b") {
      throw new Error(`failed argv=${args.join(" ")} TOP-SECRET-DELIVERY-DETAIL`);
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const deliveryFailureBatch = createCompositeTools({
    run: deliveryFailureRun,
    controller: { store: controllerStore, now: () => now, callerPaneId: controller.paneId },
    leaseStores: [workerStore, irrelevantStore],
  }).find((tool) => tool.name === "herdr_batch_handoff");
  assert(deliveryFailureBatch?.run);
  await assert.rejects(
    deliveryFailureBatch.run({
      controller_id: controller.controllerId,
      controller_lease_id: controller.leaseId,
      controller_fence_token: controller.fenceToken,
      requests: [
        { target: "worker-a", message: "PUBLIC-A" },
        { target: "worker-b", message: "PRIVATE-B" },
      ],
    }),
    (error: Error) => {
      assert.match(error.message, /batch delivery was partial/);
      assert.match(error.message, /worker-a/);
      assert.match(error.message, /worker-b/);
      assert.doesNotMatch(error.message, /PRIVATE-B|TOP-SECRET-DELIVERY-DETAIL|argv=/);
      return true;
    },
  );

  let unleasedCommandRan = false;
  const unleasedBatch = createCompositeTools({
    run: async () => {
      unleasedCommandRan = true;
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    },
    controller: { store: controllerStore, now: () => now, callerPaneId: controller.paneId },
    leaseStores: [irrelevantStore],
  }).find((tool) => tool.name === "herdr_batch_handoff");
  assert(unleasedBatch?.run);
  await assert.rejects(
    unleasedBatch.run({
      controller_id: controller.controllerId,
      controller_lease_id: controller.leaseId,
      controller_fence_token: controller.fenceToken,
      requests: [{ target: "legacy-agent", message: "Use the single handoff instead" }],
    }),
    /no retained lease/,
  );
  assert.equal(unleasedCommandRan, false);
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("batch handoff contract passed");
