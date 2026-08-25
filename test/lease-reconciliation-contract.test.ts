import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdoptedPaneLeaseStore,
  ControllerLeaseStore,
  LeaseStore,
  WriterLeaseStore,
  type ControllerLease,
  type ReviewerLease,
} from "../src/lease-store.js";
import { createSafePaneLeaseTools } from "../src/tools/safe-pane-lease.js";

const stateDir = await mkdtemp(join(tmpdir(), "herdr-mesh-reconcile-test-"));
try {
  const reviewerStore = new LeaseStore(stateDir);
  const writerStore = new WriterLeaseStore(stateDir);
  const adoptedStore = new AdoptedPaneLeaseStore(stateDir);
  const controllerStore = new ControllerLeaseStore(stateDir);
  const controller: ControllerLease = {
    version: 1,
    leaseType: "controller",
    leaseId: "11111111-1111-4111-8111-111111111111",
    controllerId: "example",
    fenceToken: "22222222-2222-4222-8222-222222222222",
    generation: 1,
    authorityRef: "https://example.test/spec",
    authoritySha256: "a".repeat(64),
    paneId: "w1:p1",
    agentName: "coordinator",
    agentKind: "codex",
    cwd: stateDir,
    state: "active",
    acquiredAt: "2026-08-25T12:00:00.000Z",
    renewedAt: "2026-08-25T12:00:00.000Z",
    expiresAt: "2026-08-25T14:00:00.000Z",
  };
  await controllerStore.create(controller);
  const reviewer: ReviewerLease = {
    version: 1,
    leaseId: "33333333-3333-4333-8333-333333333333",
    controllerId: controller.controllerId,
    purpose: "Independent review",
    parentPaneId: controller.paneId,
    paneId: "w1:p9",
    agentName: "missing-reviewer",
    agentKind: "claude",
    cwd: stateDir,
    state: "orphaned",
    createdAt: "2026-08-25T12:10:00.000Z",
  };
  await reviewerStore.create(reviewer);

  const tools = createSafePaneLeaseTools({
    run: async (args) => {
      if (args[0] === "pane" && args[1] === "get" && args[2] === reviewer.paneId) {
        throw new Error('{"error":{"code":"pane_not_found"}}');
      }
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
    adoptedStore,
    reviewerStore,
    writerStore,
    controller: {
      store: controllerStore,
      now: () => new Date("2026-08-25T13:00:00.000Z"),
      callerPaneId: controller.paneId,
    },
    now: () => new Date("2026-08-25T13:00:00.000Z"),
    uuid: () => "44444444-4444-4444-8444-444444444444",
  });
  const reconcile = tools.find((tool) => tool.name === "herdr_lease_reconcile");
  assert(reconcile?.run);
  const common = {
    controller_id: controller.controllerId,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    lease_type: "reviewer",
    lease_id: reviewer.leaseId,
  };
  const preview = JSON.parse((await reconcile.run({ ...common, dry_run: true })).content[0].text);
  assert.equal(preview.action, "would_terminalize_missing_pane");
  assert.equal((await reviewerStore.get(reviewer.leaseId)).state, "orphaned");

  const result = JSON.parse((await reconcile.run({ ...common, dry_run: false })).content[0].text);
  assert.equal(result.action, "terminalized_missing_pane");
  assert.equal((await reviewerStore.get(reviewer.leaseId)).state, "failed_closed");
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("lease reconciliation contract passed");
