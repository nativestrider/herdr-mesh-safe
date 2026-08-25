import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { runHerdr, type HerdrResult } from "../herdr.js";
import {
  AdoptedPaneLeaseStore,
  LeaseStore,
  WriterLeaseStore,
  type AdoptedPaneLease,
  type ReviewerLease,
  type WriterLease,
} from "../lease-store.js";
import {
  buildPaneCloseArgs,
  extractAgentSnapshot,
  extractAgentSnapshots,
  type AgentSnapshot,
} from "./safe-agent.js";
import {
  assertControllerAuthority,
  controllerCredentials,
  defaultControllerAuthorityDependencies,
  type ControllerAuthorityDependencies,
} from "./safe-controller.js";
import { ok, type ToolDef, targetSchema } from "./types.js";

const SHA256 = /^[0-9a-f]{64}$/i;
const agentKinds = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp",
  "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok",
  "hermes", "kilo", "qodercli", "maki",
] as const;

type Runner = (args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<HerdrResult>;

export interface SafePaneLeaseDependencies {
  run: Runner;
  adoptedStore: AdoptedPaneLeaseStore;
  reviewerStore: LeaseStore;
  writerStore: WriterLeaseStore;
  controller: ControllerAuthorityDependencies;
  now: () => Date;
  uuid: () => string;
}

const defaultDependencies: SafePaneLeaseDependencies = {
  run: runHerdr,
  adoptedStore: new AdoptedPaneLeaseStore(),
  reviewerStore: new LeaseStore(),
  writerStore: new WriterLeaseStore(),
  controller: defaultControllerAuthorityDependencies,
  now: () => new Date(),
  uuid: randomUUID,
};

type LeaseRecord =
  | { leaseType: "reviewer"; lease: ReviewerLease }
  | { leaseType: "writer"; lease: WriterLease }
  | { leaseType: "adopted-pane"; lease: AdoptedPaneLease };

function leaseCwd(record: LeaseRecord): string {
  return record.leaseType === "writer" ? record.lease.worktree : record.lease.cwd;
}

function identityMatches(snapshot: AgentSnapshot, record: LeaseRecord): boolean {
  return snapshot.paneId === record.lease.paneId &&
    snapshot.name === record.lease.agentName &&
    snapshot.kind === record.lease.agentKind &&
    Boolean(snapshot.cwd) &&
    resolve(String(snapshot.cwd)) === resolve(leaseCwd(record));
}

function leaseSummary(record: LeaseRecord): Record<string, unknown> {
  return {
    leaseType: record.leaseType,
    leaseId: record.lease.leaseId,
    controllerId: record.lease.controllerId,
    state: record.lease.state,
    paneId: record.lease.paneId,
    agentName: record.lease.agentName,
  };
}

function isRetained(record: LeaseRecord): boolean {
  if (record.leaseType === "reviewer") {
    return record.lease.state !== "closed" && record.lease.state !== "failed_closed";
  }
  if (record.leaseType === "writer") {
    return record.lease.state !== "released" && record.lease.state !== "failed_closed";
  }
  return record.lease.state !== "closed";
}

async function allLeaseRecords(dependencies: SafePaneLeaseDependencies): Promise<LeaseRecord[]> {
  return [
    ...(await dependencies.reviewerStore.list()).map((lease) => ({ leaseType: "reviewer" as const, lease })),
    ...(await dependencies.writerStore.list()).map((lease) => ({ leaseType: "writer" as const, lease })),
    ...(await dependencies.adoptedStore.list()).map((lease) => ({ leaseType: "adopted-pane" as const, lease })),
  ];
}

async function getSnapshot(run: Runner, target: string): Promise<AgentSnapshot> {
  const result = await run(["agent", "get", target], { timeoutMs: 30_000 });
  return extractAgentSnapshot(result.json);
}

async function readVisible(run: Runner, target: string, lines: number): Promise<string> {
  return (await run([
    "agent", "read", target, "--source", "visible", "--lines", String(lines), "--format", "text",
  ], { timeoutMs: 30_000 })).stdout.trim();
}

async function assertUnclaimed(
  dependencies: SafePaneLeaseDependencies,
  snapshot: AgentSnapshot,
): Promise<void> {
  const conflict = (await allLeaseRecords(dependencies)).find((record) =>
    record.lease.paneId === snapshot.paneId || record.lease.agentName === snapshot.name
  );
  if (conflict) {
    throw new Error(`agent is already recorded by ${conflict.leaseType} lease ${conflict.lease.leaseId}`);
  }
}

function validateIdentity(
  snapshot: AgentSnapshot,
  expectedPaneId: string,
  expectedName: string,
  expectedKind: string,
  expectedCwd: string,
): void {
  if (
    snapshot.paneId !== expectedPaneId ||
    snapshot.name !== expectedName ||
    snapshot.kind !== expectedKind ||
    !snapshot.cwd || resolve(snapshot.cwd) !== resolve(expectedCwd)
  ) {
    throw new Error("agent identity does not match the adoption manifest");
  }
}

async function validateAdoptedIdentity(run: Runner, lease: AdoptedPaneLease): Promise<AgentSnapshot> {
  const snapshot = await getSnapshot(run, lease.agentName);
  validateIdentity(snapshot, lease.paneId, lease.agentName, lease.agentKind, lease.cwd);
  return snapshot;
}

async function paneIsMissing(run: Runner, paneId: string): Promise<boolean> {
  try {
    await run(["pane", "get", paneId], { timeoutMs: 30_000 });
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/pane_not_found|pane[^\n]*not found|unknown pane/i.test(message)) return true;
    throw error;
  }
}

export function createSafePaneLeaseTools(dependencies = defaultDependencies): ToolDef[] {
  return [
    {
      name: "herdr_lease_inventory",
      description: "List live Herdr agents with matching reviewer, writer, or adopted-pane leases and report retained leases whose live identity is missing or changed. This is read-only.",
      inputSchema: {
        controller_id: z.string().min(1).max(100).optional(),
      },
      run: async (args) => {
        const snapshots = extractAgentSnapshots((await dependencies.run(["agent", "list"], { timeoutMs: 30_000 })).json);
        const records = (await allLeaseRecords(dependencies)).filter(isRetained);
        const controllerId = args.controller_id as string | undefined;
        const agents = snapshots.map((snapshot) => {
          const exact = records.find((record) => identityMatches(snapshot, record));
          const claimed = exact ?? records.find((record) => record.lease.paneId === snapshot.paneId || record.lease.agentName === snapshot.name);
          return {
            ...snapshot,
            leaseStatus: exact ? "matched" : claimed ? "identity_mismatch" : "unleased",
            lease: claimed ? leaseSummary(claimed) : undefined,
          };
        });
        const retainedLeases = records
          .filter((record) => !controllerId || record.lease.controllerId === controllerId)
          .map((record) => ({
            ...leaseSummary(record),
            liveIdentity: snapshots.some((snapshot) => identityMatches(snapshot, record)) ? "matched" : "missing_or_changed",
          }));
        return ok(JSON.stringify({ agents, retainedLeases }, null, 2));
      },
    },
    {
      name: "herdr_lease_reconcile",
      description: "Reconcile a retained failed lifecycle lease only when the exact leased pane is confirmed absent. Live panes and ambiguous writers are always preserved. Dry-run is the default.",
      inputSchema: {
        ...controllerCredentials,
        lease_type: z.enum(["reviewer", "writer", "adopted-pane"]),
        lease_id: z.string().uuid(),
        dry_run: z.boolean().optional(),
      },
      run: async (args) => {
        const controllerId = String(args.controller_id);
        await assertControllerAuthority(
          dependencies.controller,
          controllerId,
          String(args.controller_lease_id),
          String(args.controller_fence_token),
        );
        const leaseType = String(args.lease_type);
        const leaseId = String(args.lease_id);
        const dryRun = args.dry_run !== false;

        if (leaseType === "reviewer") {
          const result = await dependencies.reviewerStore.withExclusiveReservation(async () => {
            const lease = await dependencies.reviewerStore.get(leaseId);
            if (lease.controllerId !== controllerId) throw new Error("reviewer lease belongs to a different controller");
            if (!await paneIsMissing(dependencies.run, lease.paneId)) return { action: "preserved_live_pane", lease };
            const terminalState = lease.state === "provisioning" || lease.state === "orphaned"
              ? "failed_closed" as const
              : lease.state === "closing" || lease.state === "close_failed"
                ? "closed" as const
                : undefined;
            if (!terminalState) return { action: "preserved_state", lease };
            if (dryRun) return { action: "would_terminalize_missing_pane", terminalState, lease };
            const reconciled: ReviewerLease = {
              ...lease,
              state: terminalState,
              closedAt: dependencies.now().toISOString(),
            };
            await dependencies.reviewerStore.update(reconciled);
            return { action: "terminalized_missing_pane", lease: reconciled };
          });
          return ok(JSON.stringify(result, null, 2));
        }

        if (leaseType === "writer") {
          const result = await dependencies.writerStore.withExclusiveReservation(async () => {
            const lease = await dependencies.writerStore.get(leaseId);
            if (lease.controllerId !== controllerId) throw new Error("writer lease belongs to a different controller");
            if (!await paneIsMissing(dependencies.run, lease.paneId)) return { action: "preserved_live_pane", lease };
            const releasable = (lease.state === "releasing" || lease.state === "release_failed") &&
              Boolean(lease.checkpointRef && lease.checkpointSha256);
            if (!releasable) return { action: "preserved_ambiguous_writer", lease };
            if (dryRun) return { action: "would_terminalize_missing_pane", terminalState: "released", lease };
            const reconciled: WriterLease = {
              ...lease,
              state: "released",
              releasedAt: dependencies.now().toISOString(),
            };
            await dependencies.writerStore.update(reconciled);
            return { action: "terminalized_missing_pane", lease: reconciled };
          });
          return ok(JSON.stringify(result, null, 2));
        }

        const result = await dependencies.adoptedStore.withExclusiveReservation(async () => {
          const lease = await dependencies.adoptedStore.get(leaseId);
          if (lease.controllerId !== controllerId) throw new Error("adopted pane lease belongs to a different controller");
          if (!await paneIsMissing(dependencies.run, lease.paneId)) return { action: "preserved_live_pane", lease };
          if (lease.state !== "closing" && lease.state !== "close_failed") {
            return { action: "preserved_state", lease };
          }
          if (dryRun) return { action: "would_terminalize_missing_pane", terminalState: "closed", lease };
          const reconciled: AdoptedPaneLease = {
            ...lease,
            state: "closed",
            closedAt: dependencies.now().toISOString(),
          };
          await dependencies.adoptedStore.update(reconciled);
          return { action: "terminalized_missing_pane", lease: reconciled };
        });
        return ok(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "herdr_owned_pane_adopt",
      description: "Create a cleanup-only lease for one existing idle/done named agent after exact identity, durable authority, state cursor, and protected-pane checks. Adoption grants no Git ownership or implementation authority.",
      inputSchema: {
        ...controllerCredentials,
        purpose: z.string().min(1).max(500),
        authority_ref: z.string().min(1).max(500),
        authority_sha256: z.string().regex(SHA256),
        target: targetSchema,
        expected_pane_id: z.string().regex(/^[A-Za-z0-9]+:[A-Za-z0-9]+$/),
        expected_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
        expected_kind: z.enum(agentKinds),
        expected_cwd: z.string().min(1),
        expected_state_change_seq: z.number().int().nonnegative(),
        controller_pane_id: z.string().regex(/^[A-Za-z0-9]+:[A-Za-z0-9]+$/),
        protected_pane_ids: z.array(z.string().regex(/^[A-Za-z0-9]+:[A-Za-z0-9]+$/)).max(100).optional(),
      },
      run: async (args) => {
        await assertControllerAuthority(
          dependencies.controller,
          String(args.controller_id),
          String(args.controller_lease_id),
          String(args.controller_fence_token),
        );
        const expectedCwdInput = String(args.expected_cwd);
        if (!isAbsolute(expectedCwdInput)) throw new Error("adopted pane cwd must be absolute");
        const expectedCwd = await realpath(expectedCwdInput);
        const snapshot = await getSnapshot(dependencies.run, String(args.target));
        validateIdentity(
          snapshot,
          String(args.expected_pane_id),
          String(args.expected_name),
          String(args.expected_kind),
          expectedCwd,
        );
        if (snapshot.status !== "idle" && snapshot.status !== "done") {
          throw new Error(`agent is ${snapshot.status}; only idle or done agents may be adopted`);
        }
        if (snapshot.stateChangeSeq !== Number(args.expected_state_change_seq)) {
          throw new Error(`agent state cursor is ${snapshot.stateChangeSeq}, expected ${args.expected_state_change_seq}`);
        }
        const protectedPaneIds = new Set([
          String(args.controller_pane_id),
          ...((args.protected_pane_ids as string[] | undefined) ?? []),
        ]);
        if (protectedPaneIds.has(snapshot.paneId)) throw new Error("refusing to adopt a protected pane");

        const lease: AdoptedPaneLease = {
          version: 1,
          leaseType: "adopted-pane",
          leaseId: dependencies.uuid(),
          controllerId: String(args.controller_id),
          purpose: String(args.purpose),
          authorityRef: String(args.authority_ref),
          authoritySha256: String(args.authority_sha256),
          paneId: snapshot.paneId,
          agentName: String(snapshot.name),
          agentKind: String(snapshot.kind),
          cwd: expectedCwd,
          stateChangeSeq: snapshot.stateChangeSeq,
          state: "active",
          adoptedAt: dependencies.now().toISOString(),
        };
        await dependencies.adoptedStore.withExclusiveReservation(async () => {
          await assertUnclaimed(dependencies, snapshot);
          await dependencies.adoptedStore.create(lease);
        });
        return ok(JSON.stringify({ lease }, null, 2));
      },
    },
    {
      name: "herdr_owned_pane_list",
      description: "List cleanup-only leases for adopted legacy panes, optionally limited to one controller. This is read-only.",
      inputSchema: {
        controller_id: z.string().min(1).max(100).optional(),
      },
      run: async (args) => ok(JSON.stringify({
        leases: await dependencies.adoptedStore.list(args.controller_id as string | undefined),
      }, null, 2)),
    },
    {
      name: "herdr_owned_pane_close",
      description: "Capture and close one cleanup-only adopted pane after exact identity, idle/done state, fresh state cursor, controller, and durable checkpoint checks. Files, worktrees, and branches are preserved.",
      inputSchema: {
        lease_id: z.string().uuid(),
        ...controllerCredentials,
        expected_state_change_seq: z.number().int().nonnegative(),
        checkpoint_ref: z.string().min(1).max(500),
        checkpoint_sha256: z.string().regex(SHA256),
        read_lines: z.number().int().positive().max(2000).optional(),
      },
      run: async (args) => {
        await assertControllerAuthority(
          dependencies.controller,
          String(args.controller_id),
          String(args.controller_lease_id),
          String(args.controller_fence_token),
        );
        const { closing, output } = await dependencies.adoptedStore.withExclusiveReservation(async () => {
          const lease = await dependencies.adoptedStore.get(String(args.lease_id));
          if (lease.controllerId !== String(args.controller_id)) {
            throw new Error("adopted pane lease belongs to a different controller");
          }
          if (lease.state !== "active") throw new Error(`adopted pane lease is ${lease.state}, not active`);
          const snapshot = await validateAdoptedIdentity(dependencies.run, lease);
          if (snapshot.status !== "idle" && snapshot.status !== "done") {
            throw new Error(`agent is ${snapshot.status}; only idle or done adopted panes may be closed`);
          }
          if (snapshot.stateChangeSeq !== Number(args.expected_state_change_seq)) {
            throw new Error(`agent state cursor is ${snapshot.stateChangeSeq}, expected ${args.expected_state_change_seq}`);
          }
          const output = await readVisible(
            dependencies.run,
            lease.agentName,
            (args.read_lines as number) ?? 500,
          );
          const finalSnapshot = await validateAdoptedIdentity(dependencies.run, lease);
          if (
            (finalSnapshot.status !== "idle" && finalSnapshot.status !== "done") ||
            finalSnapshot.stateChangeSeq !== snapshot.stateChangeSeq
          ) {
            throw new Error("agent state changed while capturing output; refusing to close the pane");
          }
          const captureSha256 = createHash("sha256").update(output).digest("hex");
          const closing: AdoptedPaneLease = {
            ...lease,
            state: "closing",
            stateChangeSeq: snapshot.stateChangeSeq,
            checkpointRef: String(args.checkpoint_ref),
            checkpointSha256: String(args.checkpoint_sha256),
            captureSha256,
          };
          await dependencies.adoptedStore.update(closing);
          return { closing, output };
        });
        await assertControllerAuthority(
          dependencies.controller,
          String(args.controller_id),
          String(args.controller_lease_id),
          String(args.controller_fence_token),
        );
        try {
          await dependencies.run(buildPaneCloseArgs(closing.paneId), { timeoutMs: 30_000 });
        } catch (error) {
          await dependencies.adoptedStore.update({
            ...closing,
            state: "close_failed",
            failure: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        const closed: AdoptedPaneLease = {
          ...closing,
          state: "closed",
          closedAt: dependencies.now().toISOString(),
        };
        await dependencies.adoptedStore.update(closed);
        return ok(JSON.stringify({ lease: closed, terminalOutput: output }, null, 2));
      },
    },
  ];
}

export const safePaneLeaseTools = createSafePaneLeaseTools();
