import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { runHerdr, type HerdrResult } from "../herdr.js";
import { ControllerLeaseStore, type ControllerLease } from "../lease-store.js";
import { processDescendsFrom, readProcessIdentity, type ProcessIdentity } from "../process-attestation.js";
import { ok, type ToolDef } from "./types.js";

const SHA256 = /^[0-9a-f]{64}$/i;
const DEFAULT_TTL_SECONDS = 900;

type Runner = (args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<HerdrResult>;

interface AgentSnapshot {
  status: string;
  cwd?: string;
  name?: string;
  kind?: string;
  paneId: string;
}

export interface ControllerAuthorityDependencies {
  store: ControllerLeaseStore;
  now: () => Date;
  callerPaneId?: string;
  callerProcessId?: number;
  processDescendsFrom?: (callerPid: number, expected: ProcessIdentity) => Promise<boolean>;
}

export interface SafeControllerDependencies extends ControllerAuthorityDependencies {
  run: Runner;
  uuid: () => string;
  controllerProcessIdentity?: () => Promise<ProcessIdentity | undefined>;
}

export const defaultControllerAuthorityDependencies: ControllerAuthorityDependencies = {
  store: new ControllerLeaseStore(),
  now: () => new Date(),
  callerPaneId: process.env.HERDR_PANE_ID,
  callerProcessId: process.pid,
  processDescendsFrom,
};

const defaultDependencies: SafeControllerDependencies = {
  ...defaultControllerAuthorityDependencies,
  run: runHerdr,
  uuid: randomUUID,
  controllerProcessIdentity: () => process.platform === "linux"
    ? readProcessIdentity(process.ppid)
    : Promise.resolve(undefined),
};

function controllerProcessIdentity(
  dependencies: SafeControllerDependencies,
): Promise<ProcessIdentity | undefined> {
  if (dependencies.controllerProcessIdentity) return dependencies.controllerProcessIdentity();
  return process.platform === "linux" ? readProcessIdentity(process.ppid) : Promise.resolve(undefined);
}

function requireCallerPaneId(callerPaneId?: string): string {
  if (!callerPaneId) {
    throw new Error("HERDR_PANE_ID is required; controller mutations must originate in a Herdr-managed pane");
  }
  return callerPaneId;
}

async function liveAgents(run: Runner): Promise<AgentSnapshot[]> {
  const snapshots: AgentSnapshot[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const value = node as Record<string, unknown>;
    if (typeof value.pane_id === "string" && typeof value.agent_status === "string") {
      snapshots.push({
        status: String(value.agent_status),
        cwd: typeof value.cwd === "string" ? value.cwd : undefined,
        name: typeof value.name === "string" ? value.name : undefined,
        kind: typeof value.agent === "string" ? value.agent : undefined,
        paneId: String(value.pane_id),
      });
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit((await run(["agent", "list"], { timeoutMs: 30_000 })).json);
  return snapshots;
}

function callerIdentity(agents: AgentSnapshot[], callerPaneId?: string): AgentSnapshot {
  const paneId = requireCallerPaneId(callerPaneId);
  const snapshot = agents.find((agent) => agent.paneId === paneId);
  if (!snapshot || !snapshot.name || !snapshot.kind || !snapshot.cwd) {
    throw new Error("the Herdr caller pane does not contain one named agent with kind and cwd");
  }
  if (snapshot.status === "done" || snapshot.status === "blocked" || snapshot.status === "unknown") {
    throw new Error(`the controller caller is ${snapshot.status}, not active`);
  }
  return snapshot;
}

function identityMatches(lease: ControllerLease, snapshot: AgentSnapshot): boolean {
  return lease.paneId === snapshot.paneId &&
    lease.agentName === snapshot.name &&
    lease.agentKind === snapshot.kind &&
    Boolean(snapshot.cwd) &&
    resolve(lease.cwd) === resolve(String(snapshot.cwd));
}

export async function currentCallerControllerAuthority(
  controllerId: string,
  dependencies: SafeControllerDependencies = defaultDependencies,
): Promise<ControllerLease> {
  const lease = await dependencies.store.get(controllerId);
  await dependencies.store.assertActive(
    controllerId,
    lease.leaseId,
    lease.fenceToken,
    dependencies.now(),
  );
  const snapshot = callerIdentity(await liveAgents(dependencies.run), dependencies.callerPaneId);
  if (!identityMatches(lease, snapshot)) {
    throw new Error("controller lease does not match the current named Herdr agent");
  }
  if (!lease.controllerProcess) {
    throw new Error("controller lease lacks process attestation; resume it from the coordinator pane");
  }
  const callerProcessId = dependencies.callerProcessId ?? process.pid;
  const descendsFrom = dependencies.processDescendsFrom ?? processDescendsFrom;
  if (!await descendsFrom(callerProcessId, lease.controllerProcess)) {
    throw new Error("agent-control process is not descended from the active controller process");
  }
  return lease;
}

function expiry(now: Date, ttlSeconds: number): string {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
}

function redact(lease: ControllerLease): Omit<ControllerLease, "fenceToken"> & { expired: boolean } {
  const { fenceToken: _fenceToken, ...visible } = lease;
  return { ...visible, expired: Date.parse(lease.expiresAt) <= Date.now() };
}

export async function assertControllerAuthority(
  dependencies: ControllerAuthorityDependencies,
  controllerId: string,
  leaseId: string,
  fenceToken: string,
): Promise<ControllerLease> {
  const lease = await dependencies.store.assertActive(controllerId, leaseId, fenceToken, dependencies.now());
  if (lease.paneId !== requireCallerPaneId(dependencies.callerPaneId)) {
    throw new Error("controller lease belongs to another Herdr pane");
  }
  return lease;
}

function controllerCredentialSchema() {
  return {
    controller_id: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    controller_lease_id: z.string().uuid(),
    controller_fence_token: z.string().uuid(),
  };
}

export const controllerCredentials = controllerCredentialSchema();

export function createSafeControllerTools(dependencies = defaultDependencies): ToolDef[] {
  return [
    {
      name: "herdr_controller_acquire",
      description: "Acquire the first exclusive controller lease for the named project from this MCP client's Herdr pane. Returns an ephemeral fence token required by every coordination mutation.",
      inputSchema: {
        controller_id: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
        authority_ref: z.string().min(1).max(500),
        authority_sha256: z.string().regex(SHA256),
        ttl_seconds: z.number().int().min(60).max(1800).optional(),
      },
      run: async (args) => {
        const now = dependencies.now();
        const caller = callerIdentity(await liveAgents(dependencies.run), dependencies.callerPaneId);
        const ttl = (args.ttl_seconds as number) ?? DEFAULT_TTL_SECONDS;
        const lease: ControllerLease = {
          version: 1,
          leaseType: "controller",
          leaseId: dependencies.uuid(),
          controllerId: String(args.controller_id),
          fenceToken: dependencies.uuid(),
          generation: 1,
          authorityRef: String(args.authority_ref),
          authoritySha256: String(args.authority_sha256),
          paneId: caller.paneId,
          agentName: String(caller.name),
          agentKind: String(caller.kind),
          cwd: String(caller.cwd),
          state: "active",
          acquiredAt: now.toISOString(),
          renewedAt: now.toISOString(),
          expiresAt: expiry(now, ttl),
          controllerProcess: await controllerProcessIdentity(dependencies),
        };
        const previous = await dependencies.store.getOptional(lease.controllerId);
        if (previous) lease.generation = previous.generation + 1;
        await dependencies.store.create(lease);
        return ok(JSON.stringify({ lease }, null, 2));
      },
    },
    {
      name: "herdr_controller_resume",
      description: "Resume coordination after clear or MCP restart only from the same named Herdr agent identity. Rotates the lease id and fence token so conversational history is unnecessary.",
      inputSchema: {
        controller_id: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
        authority_ref: z.string().min(1).max(500),
        authority_sha256: z.string().regex(SHA256),
        ttl_seconds: z.number().int().min(60).max(1800).optional(),
      },
      run: async (args) => {
        const controllerId = String(args.controller_id);
        const previous = await dependencies.store.get(controllerId);
        const caller = callerIdentity(await liveAgents(dependencies.run), dependencies.callerPaneId);
        if (!identityMatches(previous, caller)) {
          throw new Error("controller identity changed; use fenced takeover after the predecessor is terminal");
        }
        const now = dependencies.now();
        const ttl = (args.ttl_seconds as number) ?? DEFAULT_TTL_SECONDS;
        const lease: ControllerLease = {
          ...previous,
          leaseId: dependencies.uuid(),
          fenceToken: dependencies.uuid(),
          generation: previous.generation + 1,
          authorityRef: String(args.authority_ref),
          authoritySha256: String(args.authority_sha256),
          state: "active",
          acquiredAt: now.toISOString(),
          renewedAt: now.toISOString(),
          expiresAt: expiry(now, ttl),
          predecessorLeaseId: previous.leaseId,
          releasedAt: undefined,
          controllerProcess: await controllerProcessIdentity(dependencies),
        };
        await dependencies.store.replace(lease, previous.leaseId);
        return ok(JSON.stringify({ lease }, null, 2));
      },
    },
    {
      name: "herdr_controller_takeover",
      description: "Transfer an expired controller lease to this Herdr pane only when the previous identity is missing, done, or blocked and the caller supplies the expected predecessor lease plus durable authority.",
      inputSchema: {
        controller_id: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
        expected_predecessor_lease_id: z.string().uuid(),
        authority_ref: z.string().min(1).max(500),
        authority_sha256: z.string().regex(SHA256),
        ttl_seconds: z.number().int().min(60).max(1800).optional(),
      },
      run: async (args) => {
        const controllerId = String(args.controller_id);
        const previous = await dependencies.store.get(controllerId);
        const now = dependencies.now();
        if (previous.state !== "active") throw new Error("released controller lease must be acquired, not taken over");
        if (previous.leaseId !== String(args.expected_predecessor_lease_id)) {
          throw new Error("predecessor lease id does not match");
        }
        if (Date.parse(previous.expiresAt) > now.getTime()) {
          throw new Error("predecessor controller lease has not expired");
        }
        const agents = await liveAgents(dependencies.run);
        const predecessor = agents.find((agent) => agent.paneId === previous.paneId);
        if (predecessor && predecessor.status !== "done" && predecessor.status !== "blocked") {
          throw new Error(`predecessor controller is ${predecessor.status}; takeover is refused`);
        }
        const caller = callerIdentity(agents, dependencies.callerPaneId);
        const ttl = (args.ttl_seconds as number) ?? DEFAULT_TTL_SECONDS;
        const lease: ControllerLease = {
          ...previous,
          leaseId: dependencies.uuid(),
          fenceToken: dependencies.uuid(),
          generation: previous.generation + 1,
          authorityRef: String(args.authority_ref),
          authoritySha256: String(args.authority_sha256),
          paneId: caller.paneId,
          agentName: String(caller.name),
          agentKind: String(caller.kind),
          cwd: String(caller.cwd),
          state: "active",
          acquiredAt: now.toISOString(),
          renewedAt: now.toISOString(),
          expiresAt: expiry(now, ttl),
          predecessorLeaseId: previous.leaseId,
          releasedAt: undefined,
          controllerProcess: await controllerProcessIdentity(dependencies),
        };
        await dependencies.store.replace(lease, previous.leaseId);
        return ok(JSON.stringify({ lease }, null, 2));
      },
    },
    {
      name: "herdr_controller_renew",
      description: "Renew the active controller lease from its exact Herdr pane and identity.",
      inputSchema: {
        ...controllerCredentialSchema(),
        ttl_seconds: z.number().int().min(60).max(1800).optional(),
      },
      run: async (args) => {
        const controllerId = String(args.controller_id);
        const previous = await assertControllerAuthority(
          dependencies,
          controllerId,
          String(args.controller_lease_id),
          String(args.controller_fence_token),
        );
        const caller = callerIdentity(await liveAgents(dependencies.run), dependencies.callerPaneId);
        if (!identityMatches(previous, caller)) throw new Error("controller identity changed; refusing renewal");
        const now = dependencies.now();
        const lease = {
          ...previous,
          renewedAt: now.toISOString(),
          expiresAt: expiry(now, (args.ttl_seconds as number) ?? DEFAULT_TTL_SECONDS),
        };
        await dependencies.store.replace(lease, previous.leaseId);
        return ok(JSON.stringify({ lease }, null, 2));
      },
    },
    {
      name: "herdr_controller_release",
      description: "Release this controller generation after durable checkpointing. The fence becomes invalid immediately; workers and reviewer leases are preserved.",
      inputSchema: {
        ...controllerCredentialSchema(),
        checkpoint_ref: z.string().min(1).max(500),
        checkpoint_sha256: z.string().regex(SHA256),
      },
      run: async (args) => {
        const controllerId = String(args.controller_id);
        const previous = await assertControllerAuthority(
          dependencies,
          controllerId,
          String(args.controller_lease_id),
          String(args.controller_fence_token),
        );
        const caller = callerIdentity(await liveAgents(dependencies.run), dependencies.callerPaneId);
        if (!identityMatches(previous, caller)) throw new Error("controller identity changed; refusing release");
        const now = dependencies.now();
        const lease: ControllerLease = {
          ...previous,
          state: "released",
          renewedAt: now.toISOString(),
          expiresAt: now.toISOString(),
          releasedAt: now.toISOString(),
          authorityRef: String(args.checkpoint_ref),
          authoritySha256: String(args.checkpoint_sha256),
        };
        await dependencies.store.replace(lease, previous.leaseId);
        return ok(JSON.stringify({ lease: redact(lease) }, null, 2));
      },
    },
    {
      name: "herdr_controller_list",
      description: "List controller lease identities and expiry without exposing fence tokens. This is read-only.",
      inputSchema: {},
      run: async () => ok(JSON.stringify({ leases: (await dependencies.store.list()).map(redact) }, null, 2)),
    },
  ];
}

export const safeControllerTools = createSafeControllerTools();
