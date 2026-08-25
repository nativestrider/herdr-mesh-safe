import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdoptedPaneLeaseStore, ControllerLeaseStore, LeaseStore, WriterLeaseStore, type ControllerLease } from "../src/lease-store.js";
import { createSafePaneLeaseTools } from "../src/tools/safe-pane-lease.js";

const stateDir = await mkdtemp(join(tmpdir(), "herdr-mesh-adopted-pane-test-"));
try {
  const adoptedStore = new AdoptedPaneLeaseStore(stateDir);
  const reviewerStore = new LeaseStore(stateDir);
  const writerStore = new WriterLeaseStore(stateDir);
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
    paneId: "w1:p7",
    agentName: "controller",
    agentKind: "codex",
    cwd: stateDir,
    state: "active",
    acquiredAt: "2026-08-25T13:00:00.000Z",
    renewedAt: "2026-08-25T13:00:00.000Z",
    expiresAt: "2026-08-25T15:00:00.000Z",
  };
  await controllerStore.create(controllerLease);
  let paneClosed = false;
  const agents = [
    {
      agent: "claude",
      agent_status: "done",
      cwd: stateDir,
      name: "legacy-reviewer",
      pane_id: "w1:p9",
      state_change_seq: 41,
    },
    {
      agent: "codex",
      agent_status: "idle",
      cwd: stateDir,
      name: "unleased-agent",
      pane_id: "w1:p10",
      state_change_seq: 42,
    },
    {
      agent: "codex",
      agent_status: "idle",
      cwd: stateDir,
      name: "controller",
      pane_id: "w1:p7",
      state_change_seq: 43,
    },
  ];
  const calls: string[][] = [];
  let mutateAfterRead = false;
  const fakeRun = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "agent" && args[1] === "list") {
      return { json: { result: { agents } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "get") {
      const agent = agents.find((candidate) => candidate.name === args[2] || candidate.pane_id === args[2]);
      if (!agent) throw new Error(`unknown agent ${args[2]}`);
      return { json: { result: { agent } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "read") {
      if (mutateAfterRead) {
        agents[0].agent_status = "working";
        agents[0].state_change_seq = 44;
      }
      return { json: { result: {} }, stdout: "legacy review captured", stderr: "" };
    }
    if (args[0] === "pane" && args[1] === "close" && args[2] === "w1:p9") {
      paneClosed = true;
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected fake Herdr call: ${args.join(" ")}`);
  };
  const tools = createSafePaneLeaseTools({
    run: fakeRun,
    adoptedStore,
    reviewerStore,
    writerStore,
    controller: {
      store: controllerStore,
      now: () => new Date("2026-08-25T14:00:00.000Z"),
      callerPaneId: "w1:p7",
    },
    now: () => new Date("2026-08-25T14:00:00.000Z"),
    uuid: () => "88888888-8888-4888-8888-888888888888",
  });
  const inventoryTool = tools.find((tool) => tool.name === "herdr_lease_inventory");
  const adoptTool = tools.find((tool) => tool.name === "herdr_owned_pane_adopt");
  const listTool = tools.find((tool) => tool.name === "herdr_owned_pane_list");
  const closeTool = tools.find((tool) => tool.name === "herdr_owned_pane_close");
  assert(inventoryTool?.run && adoptTool?.run && listTool?.run && closeTool?.run);

  const before = JSON.parse((await inventoryTool.run({ controller_id: "example-control" })).content[0].text) as {
    agents: Array<{ name?: string; leaseStatus: string }>;
  };
  assert.equal(before.agents.find((agent) => agent.name === "legacy-reviewer")?.leaseStatus, "unleased");

  const manifest = {
    controller_id: "example-control",
    controller_lease_id: controllerLease.leaseId,
    controller_fence_token: controllerLease.fenceToken,
    purpose: "Retire a completed legacy review",
    authority_ref: "https://github.com/example-org/research-app/issues/74#issuecomment-1",
    authority_sha256: "a".repeat(64),
    target: "legacy-reviewer",
    expected_pane_id: "w1:p9",
    expected_name: "legacy-reviewer",
    expected_kind: "claude",
    expected_cwd: stateDir,
    expected_state_change_seq: 41,
    controller_pane_id: "w1:p7",
    protected_pane_ids: ["w1:p1"],
  };
  await adoptTool.run(manifest);
  const leases = JSON.parse((await listTool.run({ controller_id: "example-control" })).content[0].text) as {
    leases: Array<{ leaseType: string; state: string }>;
  };
  assert.deepEqual(leases.leases.map((lease) => [lease.leaseType, lease.state]), [["adopted-pane", "active"]]);

  const after = JSON.parse((await inventoryTool.run({ controller_id: "example-control" })).content[0].text) as {
    agents: Array<{ name?: string; leaseStatus: string }>;
  };
  assert.equal(after.agents.find((agent) => agent.name === "legacy-reviewer")?.leaseStatus, "matched");
  await assert.rejects(adoptTool.run(manifest), /already recorded/);
  await assert.rejects(adoptTool.run({
    ...manifest,
    target: "controller",
    expected_pane_id: "w1:p7",
    expected_name: "controller",
    expected_kind: "codex",
    expected_state_change_seq: 43,
  }), /protected pane/);
  await assert.rejects(closeTool.run({
    lease_id: "88888888-8888-4888-8888-888888888888",
    controller_id: "example-control",
    controller_lease_id: controllerLease.leaseId,
    controller_fence_token: controllerLease.fenceToken,
    expected_state_change_seq: 40,
    checkpoint_ref: "https://github.com/example-org/research-app/issues/74#issuecomment-2",
    checkpoint_sha256: "b".repeat(64),
  }), /state cursor is 41, expected 40/);

  mutateAfterRead = true;
  await assert.rejects(closeTool.run({
    lease_id: "88888888-8888-4888-8888-888888888888",
    controller_id: "example-control",
    controller_lease_id: controllerLease.leaseId,
    controller_fence_token: controllerLease.fenceToken,
    expected_state_change_seq: 41,
    checkpoint_ref: "https://github.com/example-org/research-app/issues/74#issuecomment-2",
    checkpoint_sha256: "b".repeat(64),
  }), /state changed while capturing output/);
  mutateAfterRead = false;
  agents[0].agent_status = "done";
  agents[0].state_change_seq = 41;

  await closeTool.run({
    lease_id: "88888888-8888-4888-8888-888888888888",
    controller_id: "example-control",
    controller_lease_id: controllerLease.leaseId,
    controller_fence_token: controllerLease.fenceToken,
    expected_state_change_seq: 41,
    checkpoint_ref: "https://github.com/example-org/research-app/issues/74#issuecomment-2",
    checkpoint_sha256: "b".repeat(64),
  });
  const closed = await adoptedStore.get("88888888-8888-4888-8888-888888888888");
  assert.equal(closed.state, "closed");
  assert.equal(closed.captureSha256, createHash("sha256").update("legacy review captured").digest("hex"));
  assert.equal(paneClosed, true);
  assert(calls.some((args) => args.join(" ") === "pane close w1:p9"));
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("safe adopted pane lease contract passed");
