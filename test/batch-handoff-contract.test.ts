import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeHandoffReceipt } from "../src/handoff-receipt.js";
import {
  ControllerLeaseStore,
  type ControllerLease,
  type HandoffReceipt,
} from "../src/lease-store.js";
import { collectLeasedTargets, createCompositeTools } from "../src/tools/composite.js";

const stateDir = await mkdtemp(join(tmpdir(), "herdr-mesh-batch-handoff-test-"));

class MemoryReceiptStore {
  readonly records = new Map<string, HandoffReceipt>();
  reservations = 0;

  async create(receipt: HandoffReceipt): Promise<void> {
    assert.equal(this.records.has(receipt.receiptId), false);
    this.records.set(receipt.receiptId, structuredClone(receipt));
  }
  async update(receipt: HandoffReceipt): Promise<void> {
    assert.equal(this.records.has(receipt.receiptId), true);
    this.records.set(receipt.receiptId, structuredClone(receipt));
  }
  async get(receiptId: string): Promise<HandoffReceipt> {
    const receipt = this.records.get(receiptId);
    if (!receipt) throw new Error("missing test receipt");
    return structuredClone(receipt);
  }
  async list(): Promise<HandoffReceipt[]> {
    return [...this.records.values()].map((receipt) => structuredClone(receipt));
  }
  async withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T> {
    this.reservations += 1;
    return operation();
  }
}

try {
  const now = new Date("2026-08-25T10:00:00.000Z");
  const controllerStore = new ControllerLeaseStore(join(stateDir, "controller"));
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

  const workerLeases = [
    {
      leaseId: "33333333-3333-4333-8333-333333333333",
      agentName: "worker-a",
      paneId: "w1:p2",
      agentKind: "codex",
      cwd: "/work/worker-a",
      controllerId: controller.controllerId,
      state: "active",
    },
    {
      leaseId: "44444444-4444-4444-8444-444444444444",
      agentName: "worker-b",
      paneId: "w1:p3",
      agentKind: "codex",
      cwd: "/work/worker-b",
      controllerId: controller.controllerId,
      state: "active",
    },
  ];
  const held = new Set<string>();
  const leaseStore = {
    async list() { return workerLeases; },
    async withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T> {
      held.add("leases");
      try { return await operation(); } finally { held.delete("leases"); }
    },
  };
  let secondaryReservations = 0;
  const secondaryStore = {
    async list() { return []; },
    async withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T> {
      secondaryReservations += 1;
      held.add("secondary");
      try { return await operation(); } finally { held.delete("secondary"); }
    },
  };
  const receiptStore = new MemoryReceiptStore();
  const nameForPane = (pane: string): string => pane === "w1:p2" ? "worker-a" : "worker-b";
  const workingSeq = new Map([["worker-a", 10], ["worker-b", 20]]);
  let delayWorkerB = false;
  let supersedeWorkerA = false;
  let mutateAfterRead = false;
  let deliveryFails = false;
  let collectionFails = false;
  let controllerRotationBlocked = false;
  const taskState = new Map<string, "before" | "after">([
    ["worker-a", "before"],
    ["worker-b", "before"],
  ]);
  const readSinceGet = new Set<string>();
  const calls: string[][] = [];
  const run = async (args: string[], options?: { signal?: AbortSignal }) => {
    calls.push(args);
    assert.deepEqual([...held].sort(), ["leases", "secondary"], "all lifecycle stores stay reserved");
    const target = nameForPane(args[2]);
    const afterSeq = workingSeq.get(target) ?? 0;
    if (args[1] === "prompt") {
      if (!controllerRotationBlocked) {
        await assert.rejects(
          controllerStore.replace({
            ...controller,
            leaseId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            fenceToken: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            generation: 2,
          }, controller.leaseId),
          /controller lease reservation is busy/,
        );
        controllerRotationBlocked = true;
      }
      if (deliveryFails) throw new Error("ambiguous delivery failure");
      taskState.set(target, "after");
      return {
        json: { result: { agent: {
          agent: "codex", agent_status: "working", cwd: `/work/${target}`,
          name: target, pane_id: args[2], state_change_seq: afterSeq,
        } } },
        stdout: "",
        stderr: "",
      };
    }
    if (args[1] === "get") {
      if (collectionFails && taskState.get(target) === "after") {
        throw new Error("simulated collection timeout");
      }
      if (delayWorkerB && target === "worker-b") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 30);
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        });
      }
      const readAlreadyHappened = readSinceGet.has(target);
      const state = taskState.get(target) ?? "before";
      const sequence = state === "before"
        ? afterSeq - 1
        : afterSeq + (supersedeWorkerA && target === "worker-a" ? 2 : 1);
      if (readAlreadyHappened) {
        readSinceGet.delete(target);
        taskState.set(target, "before");
      }
      return {
        json: { result: { agent: {
          agent: mutateAfterRead && readAlreadyHappened ? "claude" : "codex",
          agent_status: "idle",
          cwd: mutateAfterRead && readAlreadyHappened ? "/wrong/cwd" : `/work/${target}`,
          name: target,
          pane_id: args[2],
          state_change_seq: sequence,
        } } },
        stdout: "",
        stderr: "",
      };
    }
    if (args[1] === "read") {
      readSinceGet.add(target);
      return { json: undefined, stdout: `output-${target}`, stderr: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  let uuidIndex = 0;
  const receiptIds = [
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "ffffffff-ffff-4fff-8fff-ffffffffffff",
    "12121212-1212-4121-8121-121212121212",
  ];
  const dependencies = {
    run,
    controller: { store: controllerStore, now: () => now, callerPaneId: controller.paneId },
    leaseStores: [leaseStore, secondaryStore],
    receiptStore,
    now: () => now,
    uuid: () => receiptIds[uuidIndex++],
  };
  const batch = createCompositeTools(dependencies).find((tool) => tool.name === "herdr_batch_handoff");
  assert(batch?.run);

  const allResult = await batch.run({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    requests: [
      { target: "worker-a", message: "Review standards" },
      { target: "worker-b", message: "Review spec" },
    ],
  });
  const all = JSON.parse(allResult.content[0].text);
  assert.deepEqual(all.completed.map((entry: { target: string }) => entry.target), ["worker-a", "worker-b"]);
  assert.deepEqual(all.completed.map((entry: { stateChangeSeq: number }) => entry.stateChangeSeq), [11, 21]);
  assert.deepEqual(all.completed.map((entry: { output: string }) => entry.output), ["output-worker-a", "output-worker-b"]);
  assert.deepEqual(all.pendingReceipts, []);
  assert.equal(controllerRotationBlocked, true, "the controller fence cannot rotate during a prompt");
  assert(secondaryReservations > 0, "every lease store is reserved before inventory");
  assert.equal((await receiptStore.get(receiptIds[0])).state, "completed");

  taskState.set("worker-a", "after");
  const replayed = await collectLeasedTargets({
    controllerId: controller.controllerId,
    controllerLeaseId: controller.leaseId,
    controllerFenceToken: controller.fenceToken,
    receipts: [all.completed[0].receipt],
  }, dependencies);
  assert.equal(JSON.parse(replayed.content[0].text).completed[0].output, "output-worker-a");

  delayWorkerB = true;
  workingSeq.set("worker-a", 30);
  workingSeq.set("worker-b", 40);
  const firstResult = await batch.run({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    mode: "first",
    requests: [
      { target: "worker-a", message: "Return first" },
      { target: "worker-b", message: "Continue" },
    ],
  });
  const first = JSON.parse(firstResult.content[0].text);
  assert.deepEqual(first.completed.map((entry: { target: string }) => entry.target), ["worker-a"]);
  assert.deepEqual(first.pendingReceipts, [encodeHandoffReceipt(receiptIds[3])]);
  assert.equal((await receiptStore.get(receiptIds[3])).state, "pending");

  await assert.rejects(batch.run({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    requests: [{ target: "worker-b", message: "Must wait for collection" }],
  }), /outstanding handoffs/);

  delayWorkerB = false;
  const collected = await collectLeasedTargets({
    controllerId: controller.controllerId,
    controllerLeaseId: controller.leaseId,
    controllerFenceToken: controller.fenceToken,
    receipts: first.pendingReceipts,
  }, dependencies);
  assert.deepEqual(JSON.parse(collected.content[0].text).completed[0].target, "worker-b");
  assert.equal((await receiptStore.get(receiptIds[3])).state, "completed");

  // A later state transition can never be mislabeled as this handoff's output.
  const staleReceipt: HandoffReceipt = {
    version: 1,
    receiptId: "99999999-9999-4999-8999-999999999999",
    controllerId: controller.controllerId,
    controllerLeaseId: controller.leaseId,
    target: "worker-a",
    targetLeaseId: workerLeases[0].leaseId,
    paneId: workerLeases[0].paneId,
    agentKind: workerLeases[0].agentKind,
    cwd: workerLeases[0].cwd,
    state: "pending",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    beforeSeq: 29,
    afterSeq: 30,
  };
  await receiptStore.create(staleReceipt);
  supersedeWorkerA = true;
  taskState.set("worker-a", "after");
  const stale = await collectLeasedTargets({
    controllerId: controller.controllerId,
    controllerLeaseId: controller.leaseId,
    controllerFenceToken: controller.fenceToken,
    receipts: [encodeHandoffReceipt(staleReceipt.receiptId)],
  }, dependencies);
  assert.deepEqual(JSON.parse(stale.content[0].text).completed, []);
  assert.equal((await receiptStore.get(staleReceipt.receiptId)).failure, "cursor_superseded");
  supersedeWorkerA = false;

  // Identity is re-read after output capture; a moving pane invalidates it.
  const movingReceipt: HandoffReceipt = {
    ...staleReceipt,
    receiptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    state: "pending",
    failure: undefined,
  };
  await receiptStore.create(movingReceipt);
  mutateAfterRead = true;
  taskState.set("worker-a", "after");
  const moving = await collectLeasedTargets({
    controllerId: controller.controllerId,
    controllerLeaseId: controller.leaseId,
    controllerFenceToken: controller.fenceToken,
    receipts: [encodeHandoffReceipt(movingReceipt.receiptId)],
  }, dependencies);
  assert.deepEqual(JSON.parse(moving.content[0].text).completed, []);
  assert.equal((await receiptStore.get(movingReceipt.receiptId)).failure, "identity_changed");
  mutateAfterRead = false;

  // An ambiguous delivery remains a barrier until an explicit, fenced
  // abandon observes the exact target settled.
  workingSeq.set("worker-a", 70);
  taskState.set("worker-a", "before");
  deliveryFails = true;
  const relay = createCompositeTools(dependencies).find((tool) => tool.name === "herdr_relay");
  const ambiguousResult = await relay?.run?.({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    target: "worker-a",
    text: "Ambiguous",
  });
  assert(ambiguousResult);
  const ambiguous = JSON.parse(ambiguousResult.content[0].text);
  assert.equal(ambiguous.failed[0].error, "delivery_ambiguous");
  const abandon = createCompositeTools(dependencies)
    .find((tool) => tool.name === "herdr_handoff_receipt_abandon");
  const abandoned = await abandon?.run?.({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    receipt: ambiguous.failed[0].receipt,
  });
  assert(abandoned);
  assert.equal(JSON.parse(abandoned.content[0].text).failure, "abandoned");
  assert.equal((await receiptStore.get(receiptIds[4])).state, "failed");
  deliveryFails = false;

  const wrongIdentity = createCompositeTools({
    ...dependencies,
    run: async (args: string[]) => {
      if (args[1] === "get") {
        return {
          json: { result: { agent: {
            agent: "claude", agent_status: "idle", cwd: "/wrong/cwd",
            name: "worker-a", pane_id: "w1:p2", state_change_seq: 69,
          } } },
          stdout: "",
          stderr: "",
        };
      }
      throw new Error("prompt must not run after preflight identity drift");
    },
  }).find((tool) => tool.name === "herdr_batch_handoff");
  await assert.rejects(wrongIdentity?.run?.({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    requests: [{ target: "worker-a", message: "Reject kind/cwd drift" }],
  }), /changed before delivery/);

  workingSeq.set("worker-a", 80);
  workingSeq.set("worker-b", 90);
  taskState.set("worker-a", "before");
  taskState.set("worker-b", "before");
  collectionFails = true;
  const allRejectedResult = await batch.run({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    mode: "first",
    requests: [
      { target: "worker-a", message: "Timeout A" },
      { target: "worker-b", message: "Timeout B" },
    ],
  });
  const allRejected = JSON.parse(allRejectedResult.content[0].text);
  assert.deepEqual(allRejected.completed, []);
  assert.equal(allRejected.failed.length, 2);
  assert.equal(allRejected.pendingReceipts.length, 2, "all rejected waits must remain collectible");
  collectionFails = false;

  let unleasedCommandRan = false;
  const unleased = createCompositeTools({
    ...dependencies,
    run: async () => {
      unleasedCommandRan = true;
      return { json: {}, stdout: "", stderr: "" };
    },
    leaseStores: [secondaryStore],
  }).find((tool) => tool.name === "herdr_batch_handoff");
  await assert.rejects(unleased?.run?.({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    requests: [{ target: "legacy", message: "No lease" }],
  }), /no retained lease/);
  assert.equal(unleasedCommandRan, false);

  // A lease introduced in a store while reservations are being acquired is
  // visible to the post-lock inventory and closes the old TOCTOU window.
  const duplicate = { ...workerLeases[0], leaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const racingStore = {
    leases: [] as typeof workerLeases,
    async list() { return this.leases; },
    async withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T> {
      this.leases = [duplicate];
      return operation();
    },
  };
  const raceBatch = createCompositeTools({ ...dependencies, leaseStores: [leaseStore, racingStore] })
    .find((tool) => tool.name === "herdr_batch_handoff");
  await assert.rejects(raceBatch?.run?.({
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    requests: [{ target: "worker-a", message: "Must not race" }],
  }), /multiple retained leases/);
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("batch handoff receipt contract passed");
