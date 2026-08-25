import {
  AdoptedPaneLeaseStore,
  ControllerLeaseStore,
  HandoffReceiptStore,
  LeaseStore,
  WriterLeaseStore,
  reservationLockStatus,
} from "../lease-store.js";
import { ok, type ToolDef } from "./types.js";

export const SAFE_BRIDGE_VERSION = "0.1.0-safe.13";
export const SAFE_BRIDGE_PROTOCOL = 2;

export const safeStatusTools: ToolDef[] = [
  {
    name: "herdr_bridge_status",
    description: "Report the safety profile, protocol version, and stable capabilities of this bridge. This is read-only and is the startup handshake for coordinators.",
    inputSchema: {},
    run: async () => {
      const reviewer = new LeaseStore();
      const writer = new WriterLeaseStore();
      const adoptedPane = new AdoptedPaneLeaseStore();
      const controller = new ControllerLeaseStore();
      const handoffReceipt = new HandoffReceiptStore();
      return ok(JSON.stringify({
        name: "herdr-mesh-safe",
        version: SAFE_BRIDGE_VERSION,
        protocol: SAFE_BRIDGE_PROTOCOL,
        profile: "safe-orchestration",
        capabilities: [
          "batch-handoff-v1",
          "controller-cli-v1",
          "controller-fencing-v1",
          "handoff-receipts-v1",
          "lease-reconciliation-v1",
          "owned-pane-cleanup-v1",
          "owned-reviewer-tabs-v1",
          "owned-worker-lanes-v1",
          "owned-worker-host-verification-v1",
          "python-requirements-bootstrap-v1",
        ],
        reservationLocks: {
          reviewer: await reservationLockStatus(reviewer.directory),
          writer: await reservationLockStatus(writer.directory),
          adoptedPane: await reservationLockStatus(adoptedPane.directory),
          controller: await reservationLockStatus(controller.directory),
          handoffReceipt: await reservationLockStatus(handoffReceipt.directory),
        },
      }, null, 2));
    },
  },
];
