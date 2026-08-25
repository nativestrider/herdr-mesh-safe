import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";
import { z } from "zod";
import { runGit, type GitResult } from "../git.js";
import { runHerdr, type HerdrResult } from "../herdr.js";
import { WriterLeaseStore, type WriterLease } from "../lease-store.js";
import {
  assertControllerAuthority,
  controllerCredentials,
  defaultControllerAuthorityDependencies,
  type ControllerAuthorityDependencies,
} from "./safe-controller.js";
import {
  buildPaneCloseArgs,
  buildTabCreateArgs,
  extractAgentSnapshot,
  extractAgentSnapshots,
  extractPaneId,
  extractWorkspaceId,
  MIN_AGENT_START_TIMEOUT_MS,
  startAgentWhenShellReady,
} from "./safe-agent.js";
import { ok, type ToolDef } from "./types.js";

const agentKinds = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp",
  "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok",
  "hermes", "kilo", "qodercli", "maki",
] as const;
const SHA = /^[0-9a-f]{40,64}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const retainedWriterStates = new Set(["provisioning", "active", "releasing", "orphaned", "release_failed"]);

type HerdrRunner = (args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<HerdrResult>;
type GitRunner = (args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<GitResult>;

export interface SafeWriterDependencies {
  herdr: HerdrRunner;
  git: GitRunner;
  store: WriterLeaseStore;
  controller: ControllerAuthorityDependencies;
  now: () => Date;
  uuid: () => string;
  pause?: (milliseconds: number) => Promise<void>;
}

interface GitFacts {
  repositoryRoot: string;
  gitDir: string;
  gitCommonDir: string;
  worktree: string;
  branch: string;
  headCommit: string;
  gitStatusSha256: string;
}

const defaultDependencies: SafeWriterDependencies = {
  herdr: runHerdr,
  git: runGit,
  store: new WriterLeaseStore(),
  controller: defaultControllerAuthorityDependencies,
  now: () => new Date(),
  uuid: randomUUID,
  pause: (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)),
};

export function hashGitStatus(status: string): string {
  return createHash("sha256").update(status).digest("hex");
}

export function normalizeOwnershipScopes(scopes: string[]): string[] {
  const normalized = scopes.map((scope) => {
    if (!scope || scope.includes("\\") || /[*?[\]{}]/.test(scope)) {
      throw new Error("ownership scopes must use literal path segments");
    }
    if (scope.startsWith("/") || scope.split("/").includes("..")) {
      throw new Error("ownership scopes must be repository-relative");
    }
    const value = posix.normalize(scope).replace(/^\.\//, "").replace(/\/$/, "");
    if (!value || value === ".") throw new Error("ownership scopes must identify a repository path");
    return value;
  });
  return [...new Set(normalized)].sort();
}

function scopeContains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}/`);
}

export function ownershipScopesOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => scopeContains(a, b) || scopeContains(b, a)));
}

async function gitText(git: GitRunner, args: string[]): Promise<string> {
  return (await git(args, { timeoutMs: 30_000 })).stdout.trim();
}

async function inspectGit(git: GitRunner, worktreeInput: string, baseCommit: string): Promise<GitFacts> {
  if (!isAbsolute(worktreeInput)) throw new Error("writer worktree must be absolute");
  if (!SHA.test(baseCommit)) throw new Error("base_commit must be a full Git object id");
  const worktree = await realpath(worktreeInput);
  const repositoryRoot = await realpath(await gitText(git, ["-C", worktree, "rev-parse", "--show-toplevel"]));
  if (repositoryRoot !== worktree) throw new Error("writer worktree must point to the repository root");
  const gitDir = resolve(await gitText(git, ["-C", worktree, "rev-parse", "--absolute-git-dir"]));
  const gitCommonDir = resolve(await gitText(git, [
    "-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir",
  ]));
  if (gitDir === gitCommonDir) {
    throw new Error("writer worktree must be a linked Git worktree; the primary checkout is refused");
  }
  const branch = await gitText(git, ["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const headCommit = await gitText(git, ["-C", worktree, "rev-parse", "HEAD"]);
  if (!SHA.test(headCommit)) throw new Error("writer HEAD is not a full Git object id");
  await git(["-C", worktree, "merge-base", "--is-ancestor", baseCommit, headCommit], { timeoutMs: 30_000 });
  const status = (await git([
    "-C", worktree, "status", "--porcelain=v1", "--untracked-files=all",
  ], { timeoutMs: 30_000 })).stdout;
  return { repositoryRoot, gitDir, gitCommonDir, worktree, branch, headCommit, gitStatusSha256: hashGitStatus(status) };
}

function validateExpectedGit(
  facts: GitFacts,
  expectedBranch: string,
  expectedHead: string,
  expectedStatusSha256: string,
): void {
  if (facts.branch !== expectedBranch) throw new Error(`writer branch is ${facts.branch}, expected ${expectedBranch}`);
  if (facts.headCommit !== expectedHead) throw new Error(`writer HEAD is ${facts.headCommit}, expected ${expectedHead}`);
  if (facts.gitStatusSha256 !== expectedStatusSha256) {
    throw new Error(`writer git status digest is ${facts.gitStatusSha256}, expected ${expectedStatusSha256}`);
  }
}

function validateNoConflict(candidate: WriterLease, leases: WriterLease[]): void {
  for (const lease of leases) {
    if (!retainedWriterStates.has(lease.state) || lease.gitCommonDir !== candidate.gitCommonDir) continue;
    if (lease.worktree === candidate.worktree) throw new Error(`writer worktree is retained by lease ${lease.leaseId}`);
    if (lease.branch === candidate.branch) throw new Error(`writer branch is retained by lease ${lease.leaseId}`);
    if (ownershipScopesOverlap(lease.ownedScopes, candidate.ownedScopes)) {
      throw new Error(`writer ownership overlaps lease ${lease.leaseId}`);
    }
    if (ownershipScopesOverlap(lease.lockedScopes, candidate.ownedScopes)) {
      throw new Error(`writer ownership overlaps a locked scope in lease ${lease.leaseId}`);
    }
  }
}

async function validateWorktreeHasNoAgent(herdr: HerdrRunner, worktree: string): Promise<void> {
  const agents = extractAgentSnapshots((await herdr(["agent", "list"], { timeoutMs: 30_000 })).json);
  const occupant = agents.find((agent) => agent.cwd && resolve(agent.cwd) === resolve(worktree));
  if (occupant) {
    throw new Error(`writer worktree is already occupied by Herdr agent ${occupant.name ?? occupant.paneId}`);
  }
}

async function getWriterAgent(herdr: HerdrRunner, lease: WriterLease) {
  const result = await herdr(["agent", "get", lease.agentName], { timeoutMs: 30_000 });
  const snapshot = extractAgentSnapshot(result.json);
  if (
    snapshot.paneId !== lease.paneId ||
    snapshot.name !== lease.agentName ||
    snapshot.kind !== lease.agentKind ||
    !snapshot.cwd || resolve(snapshot.cwd) !== resolve(lease.worktree)
  ) {
    throw new Error("writer identity no longer matches its lease; refusing lifecycle action");
  }
  return snapshot;
}

async function readWriterOutput(herdr: HerdrRunner, target: string, lines: number): Promise<string> {
  return (await herdr([
    "agent", "read", target, "--source", "visible", "--lines", String(lines), "--format", "text",
  ])).stdout.trim();
}

export function createSafeWriterTools(dependencies = defaultDependencies): ToolDef[] {
  return [
    {
      name: "herdr_owned_worker_start",
      description: "Reserve a manifest-scoped Git lane, verify its branch/base/HEAD/status digest and active ownership leases, then start one leased writer in a dedicated no-focus tab. The controller tab is never split. Durable ticket/spec authority must already have been validated by the coordinator.",
      inputSchema: {
        ...controllerCredentials,
        purpose: z.string().min(1).max(500),
        ticket_ref: z.string().min(1).max(500),
        authority_ref: z.string().min(1).max(500),
        authority_sha256: z.string().regex(SHA256),
        parent_pane_id: z.string().regex(/^[A-Za-z0-9]+:[A-Za-z0-9]+$/),
        worktree: z.string().min(1),
        branch: z.string().min(1).max(500),
        base_commit: z.string().regex(SHA),
        expected_head: z.string().regex(SHA),
        expected_status_sha256: z.string().regex(SHA256),
        owned_scopes: z.array(z.string()).min(1).max(500),
        locked_scopes: z.array(z.string()).max(500),
        protected_branches: z.array(z.string().min(1).max(500)).min(1).max(20),
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
        kind: z.enum(agentKinds),
        start_timeout_ms: z.number().int().min(MIN_AGENT_START_TIMEOUT_MS).max(300_000).optional(),
      },
      run: async (args) => {
        await assertControllerAuthority(
          dependencies.controller,
          String(args.controller_id),
          String(args.controller_lease_id),
          String(args.controller_fence_token),
        );
        const baseCommit = String(args.base_commit);
        const expectedHead = String(args.expected_head);
        const expectedStatusSha256 = String(args.expected_status_sha256);
        const facts = await inspectGit(dependencies.git, String(args.worktree), baseCommit);
        validateExpectedGit(facts, String(args.branch), expectedHead, expectedStatusSha256);
        await validateWorktreeHasNoAgent(dependencies.herdr, facts.worktree);
        const ownedScopes = normalizeOwnershipScopes(args.owned_scopes as string[]);
        const lockedScopes = normalizeOwnershipScopes(args.locked_scopes as string[]);
        const protectedBranches = [...new Set((args.protected_branches as string[]).map((branch) => branch.trim()))].sort();
        if (protectedBranches.includes(facts.branch)) {
          throw new Error(`writer branch ${facts.branch} is protected`);
        }
        if (ownershipScopesOverlap(ownedScopes, lockedScopes)) {
          throw new Error("writer ownership overlaps a locked scope");
        }
        let lease: WriterLease = {
          version: 1,
          leaseType: "writer",
          leaseId: dependencies.uuid(),
          controllerId: String(args.controller_id),
          purpose: String(args.purpose),
          ticketRef: String(args.ticket_ref),
          authorityRef: String(args.authority_ref),
          authoritySha256: String(args.authority_sha256),
          parentPaneId: String(args.parent_pane_id),
          paneId: "",
          agentName: String(args.name),
          agentKind: String(args.kind),
          repositoryRoot: facts.repositoryRoot,
          gitDir: facts.gitDir,
          gitCommonDir: facts.gitCommonDir,
          worktree: facts.worktree,
          branch: facts.branch,
          baseCommit,
          headCommit: facts.headCommit,
          gitStatusSha256: facts.gitStatusSha256,
          ownedScopes,
          lockedScopes,
          protectedBranches,
          state: "provisioning",
          createdAt: dependencies.now().toISOString(),
        };
        await dependencies.store.withExclusiveReservation(async () => {
          validateNoConflict(lease, await dependencies.store.list());
          await dependencies.store.create(lease);
        });
        try {
          const parentPane = await dependencies.herdr(["pane", "get", lease.parentPaneId]);
          const workspaceId = extractWorkspaceId(parentPane.json);
          const tab = await dependencies.herdr(buildTabCreateArgs(workspaceId, lease.worktree, lease.agentName));
          lease = { ...lease, paneId: extractPaneId(tab.json) };
          await dependencies.store.update(lease);
          const startTimeout = (args.start_timeout_ms as number) ?? 30_000;
          await startAgentWhenShellReady(
            dependencies.herdr,
            lease.agentName,
            lease.agentKind,
            lease.paneId,
            startTimeout,
            undefined,
            undefined,
            dependencies.pause,
          );
          await getWriterAgent(dependencies.herdr, lease);
          const active = { ...lease, state: "active" as const };
          await dependencies.store.update(active);
          return ok(JSON.stringify({ lease: active }, null, 2));
        } catch (error) {
          if (!lease.paneId) {
            await dependencies.store.update({
              ...lease,
              state: "failed_closed",
              failure: error instanceof Error ? error.message : String(error),
            });
          } else {
            try {
              await dependencies.herdr(buildPaneCloseArgs(lease.paneId));
              await dependencies.store.update({
                ...lease,
                state: "failed_closed",
                failure: error instanceof Error ? error.message : String(error),
              });
            } catch (closeError) {
              await dependencies.store.update({
                ...lease,
                state: "orphaned",
                failure: `${error instanceof Error ? error.message : String(error)}; rollback failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
              });
            }
          }
          throw error;
        }
      },
    },
    {
      name: "herdr_owned_worker_list",
      description: "List persistent writer leases, optionally limited to one controller. This is read-only.",
      inputSchema: { controller_id: z.string().min(1).max(100).optional() },
      run: async (args) => ok(JSON.stringify({ leases: await dependencies.store.list(args.controller_id as string | undefined) }, null, 2)),
    },
    {
      name: "herdr_owned_worker_release",
      description: "Release only an idle/done identity-matched writer after revalidating branch, HEAD, Git status digest, and a durable checkpoint reference. The worktree and bytes are preserved.",
      inputSchema: {
        lease_id: z.string().uuid(),
        ...controllerCredentials,
        expected_state_change_seq: z.number().int().nonnegative(),
        expected_head: z.string().regex(SHA),
        expected_status_sha256: z.string().regex(SHA256),
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
        const { releasing, output } = await dependencies.store.withExclusiveReservation(async () => {
          const lease = await dependencies.store.get(String(args.lease_id));
          if (lease.controllerId !== String(args.controller_id)) throw new Error("writer lease belongs to a different controller");
          if (lease.state !== "active") throw new Error(`writer lease is ${lease.state}, not active`);
          const snapshot = await getWriterAgent(dependencies.herdr, lease);
          if (snapshot.status !== "idle" && snapshot.status !== "done") {
            throw new Error(`writer is ${snapshot.status}; only idle or done writers may be released`);
          }
          if (snapshot.stateChangeSeq !== Number(args.expected_state_change_seq)) {
            throw new Error(`agent state cursor is ${snapshot.stateChangeSeq}, expected ${args.expected_state_change_seq}`);
          }
          const facts = await inspectGit(dependencies.git, lease.worktree, lease.baseCommit);
          validateExpectedGit(
            facts,
            lease.branch,
            String(args.expected_head),
            String(args.expected_status_sha256),
          );
          const output = await readWriterOutput(
            dependencies.herdr,
            lease.agentName,
            (args.read_lines as number) ?? 500,
          );
          const finalSnapshot = await getWriterAgent(dependencies.herdr, lease);
          if (
            (finalSnapshot.status !== "idle" && finalSnapshot.status !== "done") ||
            finalSnapshot.stateChangeSeq !== snapshot.stateChangeSeq
          ) {
            throw new Error("agent state changed while capturing output; refusing to release the writer");
          }
          const captureSha256 = createHash("sha256").update(output).digest("hex");
          const releasing: WriterLease = {
            ...lease,
            state: "releasing",
            headCommit: facts.headCommit,
            gitStatusSha256: facts.gitStatusSha256,
            checkpointRef: String(args.checkpoint_ref),
            checkpointSha256: String(args.checkpoint_sha256),
            captureSha256,
          };
          await dependencies.store.update(releasing);
          return { releasing, output };
        });
        await assertControllerAuthority(
          dependencies.controller,
          String(args.controller_id),
          String(args.controller_lease_id),
          String(args.controller_fence_token),
        );
        try {
          await dependencies.herdr(buildPaneCloseArgs(releasing.paneId));
        } catch (error) {
          await dependencies.store.update({
            ...releasing,
            state: "release_failed",
            failure: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        const released: WriterLease = {
          ...releasing,
          state: "released",
          releasedAt: dependencies.now().toISOString(),
        };
        await dependencies.store.update(released);
        return ok(JSON.stringify({ lease: released, terminalOutput: output }, null, 2));
      },
    },
  ];
}

export const safeWriterTools = createSafeWriterTools();
