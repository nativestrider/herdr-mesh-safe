import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { HerdrError, runHerdr, type HerdrResult } from "../herdr.js";
import { LeaseStore, type ReviewerLease } from "../lease-store.js";
import { ok, type ToolDef, type ToolResult, targetSchema } from "./types.js";

const settledStatuses = new Set(["idle", "done", "blocked"]);
const agentKinds = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp",
  "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok",
  "hermes", "kilo", "qodercli", "maki",
] as const;

export interface AgentSnapshot {
  target: string;
  kind?: string;
  status: string;
  cwd?: string;
  name?: string;
  paneId: string;
  stateChangeSeq: number;
}

type Runner = (args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<HerdrResult>;

export interface SafeAgentDependencies {
  run: Runner;
  store: LeaseStore;
  now: () => Date;
  uuid: () => string;
}

const defaultDependencies: SafeAgentDependencies = {
  run: runHerdr,
  store: new LeaseStore(),
  now: () => new Date(),
  uuid: randomUUID,
};

export function buildSettledWaitArgs(target: string, timeoutMs: number): string[] {
  return ["agent", "wait", target, "--timeout", String(timeoutMs)];
}

export function buildPaneSplitArgs(parentPaneId: string, direction: string, cwd: string): string[] {
  return ["pane", "split", parentPaneId, "--direction", direction, "--cwd", cwd, "--no-focus"];
}

export function buildAgentStartArgs(name: string, kind: string, paneId: string, timeoutMs: number): string[] {
  return ["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(timeoutMs)];
}

export function buildPaneCloseArgs(paneId: string): string[] {
  return ["pane", "close", paneId];
}

function findObject(node: unknown, predicate: (value: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = findObject(value, predicate);
      if (found) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (predicate(record)) return record;
  for (const value of Object.values(record)) {
    const found = findObject(value, predicate);
    if (found) return found;
  }
  return undefined;
}

export function extractAgentSnapshot(json: unknown): AgentSnapshot {
  const value = findObject(
    json,
    (record) => typeof record.pane_id === "string" && typeof record.agent_status === "string",
  );
  if (!value) throw new Error("Herdr response did not contain an agent snapshot");
  const target = typeof value.name === "string" ? value.name : String(value.pane_id);
  return {
    target,
    kind: typeof value.agent === "string" ? value.agent : undefined,
    status: String(value.agent_status),
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    paneId: String(value.pane_id),
    stateChangeSeq: typeof value.state_change_seq === "number" ? value.state_change_seq : 0,
  };
}

export function extractAgentSnapshots(json: unknown): AgentSnapshot[] {
  const snapshots: AgentSnapshot[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const value = node as Record<string, unknown>;
    if (typeof value.pane_id === "string" && typeof value.agent_status === "string") {
      snapshots.push(extractAgentSnapshot(value));
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(json);
  return snapshots;
}

export function extractPaneId(json: unknown): string {
  const value = findObject(json, (record) => typeof record.pane_id === "string");
  if (!value) throw new Error("Herdr response did not contain a pane id");
  return String(value.pane_id);
}

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new HerdrError("timed out waiting for a new settled agent state");
  return value;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes("timed out");
}

async function getSnapshot(run: Runner, target: string, signal?: AbortSignal): Promise<AgentSnapshot> {
  const result = await run(["agent", "get", target], { timeoutMs: 30_000, signal });
  return { ...extractAgentSnapshot(result.json), target };
}

async function waitForSettled(
  run: Runner,
  target: string,
  timeoutMs: number,
  afterSeq?: number,
  signal?: AbortSignal,
): Promise<AgentSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = await getSnapshot(run, target, signal);
    const isNew = afterSeq === undefined || snapshot.stateChangeSeq > afterSeq;
    if (isNew && settledStatuses.has(snapshot.status)) return snapshot;

    const timeout = remaining(deadline);
    const args = snapshot.status === "working"
      ? buildSettledWaitArgs(target, timeout)
      : ["agent", "wait", target, "--until", "working", "--timeout", String(Math.min(timeout, 5000))];
    try {
      await run(args, { timeoutMs: timeout + 2000, signal });
    } catch (error) {
      if (!isTimeout(error)) throw error;
    }
  }
}

async function readVisible(run: Runner, target: string, lines: number): Promise<string> {
  const result = await run([
    "agent", "read", target, "--source", "visible", "--lines", String(lines), "--format", "text",
  ]);
  return result.stdout.trim();
}

async function settledResult(run: Runner, snapshot: AgentSnapshot, lines: number): Promise<ToolResult> {
  const output = await readVisible(run, snapshot.target, lines);
  return ok(JSON.stringify({ event: "agent_settled", agent: snapshot, output }, null, 2));
}

function validateLeaseOwner(lease: ReviewerLease, controllerId: string): void {
  if (lease.controllerId !== controllerId) throw new Error("reviewer lease belongs to a different controller");
}

async function validateLeaseIdentity(run: Runner, lease: ReviewerLease): Promise<AgentSnapshot> {
  const snapshot = await getSnapshot(run, lease.agentName);
  if (
    snapshot.paneId !== lease.paneId ||
    snapshot.name !== lease.agentName ||
    snapshot.kind !== lease.agentKind ||
    !snapshot.cwd || resolve(snapshot.cwd) !== resolve(lease.cwd)
  ) {
    throw new Error("reviewer identity no longer matches its lease; refusing lifecycle action");
  }
  return snapshot;
}

async function closeOwnedReviewer(
  dependencies: SafeAgentDependencies,
  leaseId: string,
  controllerId: string,
  lines: number,
): Promise<Record<string, unknown>> {
  const lease = await dependencies.store.get(leaseId);
  validateLeaseOwner(lease, controllerId);
  if (lease.state !== "active") throw new Error(`reviewer lease is ${lease.state}, not active`);
  const snapshot = await validateLeaseIdentity(dependencies.run, lease);
  if (!settledStatuses.has(snapshot.status) || snapshot.status === "blocked") {
    throw new Error(`reviewer is ${snapshot.status}; only idle or done reviewers may be closed`);
  }
  const output = await readVisible(dependencies.run, lease.agentName, lines);
  const captureSha256 = createHash("sha256").update(output).digest("hex");
  await dependencies.store.update({ ...lease, state: "closing", captureSha256 });
  try {
    await dependencies.run(buildPaneCloseArgs(lease.paneId));
  } catch (error) {
    await dependencies.store.update({
      ...lease,
      state: "close_failed",
      captureSha256,
      failure: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const closed: ReviewerLease = {
    ...lease,
    state: "closed",
    closedAt: dependencies.now().toISOString(),
    captureSha256,
  };
  await dependencies.store.update(closed);
  return { lease: closed, terminalOutput: output };
}

export function createSafeAgentTools(dependencies = defaultDependencies): ToolDef[] {
  return [
    {
      name: "herdr_agent_wait_settled",
      description: "Wait for an agent to become idle, done, or blocked, then return its state and visible output. Use after_seq to wait for a newer state transition instead of accepting stale terminal state.",
      inputSchema: {
        target: targetSchema,
        after_seq: z.number().int().nonnegative().optional(),
        timeout_ms: z.number().int().positive().max(600_000).optional(),
        read_lines: z.number().int().positive().max(2000).optional(),
      },
      run: async (args) => {
        const snapshot = await waitForSettled(
          dependencies.run,
          String(args.target),
          (args.timeout_ms as number) ?? 600_000,
          args.after_seq as number | undefined,
        );
        return settledResult(dependencies.run, snapshot, (args.read_lines as number) ?? 200);
      },
    },
    {
      name: "herdr_agent_wait_any",
      description: "Wait concurrently for the first of several agents to become idle, done, or blocked. Losing waits are cancelled. Per-target after_seq cursors prevent stale terminal states.",
      inputSchema: {
        targets: z.array(z.object({ target: targetSchema, after_seq: z.number().int().nonnegative().optional() })).min(1).max(16),
        timeout_ms: z.number().int().positive().max(600_000).optional(),
        read_lines: z.number().int().positive().max(2000).optional(),
      },
      run: async (args) => {
        const targets = args.targets as Array<{ target: string; after_seq?: number }>;
        const timeout = (args.timeout_ms as number) ?? 600_000;
        const controllers = targets.map(() => new AbortController());
        const waits = targets.map((target, index) =>
          waitForSettled(
            dependencies.run,
            String(target.target),
            timeout,
            target.after_seq,
            controllers[index].signal,
          ),
        );
        try {
          const snapshot = await Promise.any(waits);
          controllers.forEach((controller) => controller.abort());
          return settledResult(dependencies.run, snapshot, (args.read_lines as number) ?? 200);
        } catch (error) {
          controllers.forEach((controller) => controller.abort());
          throw error;
        }
      },
    },
    {
      name: "herdr_owned_reviewer_start",
      description: "Create a no-focus split, start one supported reviewer in it, verify its identity, and persist a lease. This does not accept arbitrary shell commands or agent arguments.",
      inputSchema: {
        controller_id: z.string().min(1).max(100),
        purpose: z.string().min(1).max(500),
        parent_pane_id: z.string().min(1),
        cwd: z.string().min(1),
        name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
        kind: z.enum(agentKinds),
        direction: z.enum(["right", "down"]).optional(),
        start_timeout_ms: z.number().int().positive().max(300_000).optional(),
      },
      run: async (args) => {
        const cwdInput = String(args.cwd);
        if (!isAbsolute(cwdInput)) throw new Error("reviewer cwd must be absolute");
        const cwd = await realpath(cwdInput);
        if (!(await stat(cwd)).isDirectory()) throw new Error("reviewer cwd is not a directory");
        const parentPaneId = String(args.parent_pane_id);
        const direction = String(args.direction ?? "right");
        const split = await dependencies.run(buildPaneSplitArgs(parentPaneId, direction, cwd));
        const paneId = extractPaneId(split.json);
        const lease: ReviewerLease = {
          version: 1,
          leaseId: dependencies.uuid(),
          controllerId: String(args.controller_id),
          purpose: String(args.purpose),
          parentPaneId,
          paneId,
          agentName: String(args.name),
          agentKind: String(args.kind),
          cwd,
          state: "provisioning",
          createdAt: dependencies.now().toISOString(),
        };
        try {
          await dependencies.store.create(lease);
        } catch (error) {
          await dependencies.run(buildPaneCloseArgs(paneId));
          throw error;
        }
        try {
          const startTimeout = (args.start_timeout_ms as number) ?? 30_000;
          await dependencies.run(
            buildAgentStartArgs(lease.agentName, lease.agentKind, paneId, startTimeout),
            { timeoutMs: startTimeout + 5000 },
          );
          await validateLeaseIdentity(dependencies.run, lease);
          const active = { ...lease, state: "active" as const };
          await dependencies.store.update(active);
          return ok(JSON.stringify({ lease: active }, null, 2));
        } catch (error) {
          try {
            await dependencies.run(buildPaneCloseArgs(paneId));
            await dependencies.store.update({
              ...lease,
              state: "failed_closed",
              closedAt: dependencies.now().toISOString(),
              failure: error instanceof Error ? error.message : String(error),
            });
          } catch (closeError) {
            await dependencies.store.update({
              ...lease,
              state: "orphaned",
              failure: `${error instanceof Error ? error.message : String(error)}; rollback failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
            });
          }
          throw error;
        }
      },
    },
    {
      name: "herdr_owned_reviewer_list",
      description: "List persistent reviewer leases, optionally limited to one controller. This is read-only.",
      inputSchema: { controller_id: z.string().min(1).max(100).optional() },
      run: async (args) => ok(JSON.stringify({ leases: await dependencies.store.list(args.controller_id as string | undefined) }, null, 2)),
    },
    {
      name: "herdr_owned_reviewer_close",
      description: "Capture and close only an idle or done reviewer whose pane, agent kind, name, cwd, controller, and lease still match. Blocked or working reviewers are refused.",
      inputSchema: {
        lease_id: z.string().uuid(),
        controller_id: z.string().min(1).max(100),
        read_lines: z.number().int().positive().max(2000).optional(),
      },
      run: async (args) => ok(JSON.stringify(await closeOwnedReviewer(
        dependencies,
        String(args.lease_id),
        String(args.controller_id),
        (args.read_lines as number) ?? 500,
      ), null, 2)),
    },
    {
      name: "herdr_owned_reviewer_cleanup",
      description: "Inspect reviewer leases for one controller and optionally close only identity-matched idle/done reviewers. Dry-run is the default; blocked, working, and ambiguous leases are preserved.",
      inputSchema: {
        controller_id: z.string().min(1).max(100),
        dry_run: z.boolean().optional(),
        read_lines: z.number().int().positive().max(2000).optional(),
      },
      run: async (args) => {
        const controllerId = String(args.controller_id);
        const dryRun = args.dry_run !== false;
        const results: Array<Record<string, unknown>> = [];
        for (const lease of await dependencies.store.list(controllerId)) {
          if (lease.state !== "active") continue;
          try {
            const snapshot = await validateLeaseIdentity(dependencies.run, lease);
            if (!settledStatuses.has(snapshot.status) || snapshot.status === "blocked") {
              results.push({ leaseId: lease.leaseId, action: "preserved", status: snapshot.status });
            } else if (dryRun) {
              results.push({ leaseId: lease.leaseId, action: "would_close", status: snapshot.status });
            } else {
              results.push({ leaseId: lease.leaseId, action: "closed", result: await closeOwnedReviewer(
                dependencies,
                lease.leaseId,
                controllerId,
                (args.read_lines as number) ?? 500,
              ) });
            }
          } catch (error) {
            results.push({ leaseId: lease.leaseId, action: "preserved", error: error instanceof Error ? error.message : String(error) });
          }
        }
        return ok(JSON.stringify({ dryRun, results }, null, 2));
      },
    },
  ];
}

export const safeAgentTools = createSafeAgentTools();
