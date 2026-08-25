import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashGitStatus,
  normalizeOwnershipScopes,
  ownershipScopesOverlap,
  createSafeWriterTools,
} from "../src/tools/safe-writer.js";
import { WriterLeaseStore, type WriterLease } from "../src/lease-store.js";

assert.deepEqual(normalizeOwnershipScopes(["docs/adr/", "src/example_app/api/projects.py"]), [
  "docs/adr",
  "src/example_app/api/projects.py",
]);
assert.throws(() => normalizeOwnershipScopes(["../outside"]), /repository-relative/);
assert.throws(() => normalizeOwnershipScopes(["docs/*"]), /literal path segments/);
assert.equal(ownershipScopesOverlap(["docs/adr"], ["docs/adr/0032.md"]), true);
assert.equal(ownershipScopesOverlap(["docs/adr/0031.md"], ["docs/adr/0032.md"]), false);
assert.equal(hashGitStatus(" M docs/adr/0032.md\n"), "1bcbb5dc5e5daa0d590c351b965b7c9ad341b93238c2789812fd5db68624dd00");

const stateDir = await mkdtemp(join(tmpdir(), "herdr-mesh-writer-lease-test-"));
try {
  const store = new WriterLeaseStore(stateDir);
  const lease: WriterLease = {
    version: 1,
    leaseType: "writer",
    leaseId: "44444444-4444-4444-8444-444444444444",
    controllerId: "example-project",
    purpose: "Implement ticket 85",
    ticketRef: "https://github.com/example-org/research-app/issues/85",
    authorityRef: "https://github.com/example-org/research-app/issues/74",
    authoritySha256: "a".repeat(64),
    parentPaneId: "w1:p1",
    paneId: "w1:p4",
    agentName: "epy85-writer",
    agentKind: "codex",
    repositoryRoot: "/work/research-app-wt-0085",
    gitDir: "/work/research-app/.git/worktrees/research-app-wt-0085",
    gitCommonDir: "/work/research-app/.git",
    worktree: "/work/research-app-wt-0085",
    branch: "codex/0085-adrs",
    baseCommit: "1".repeat(40),
    headCommit: "2".repeat(40),
    gitStatusSha256: "3".repeat(64),
    ownedScopes: ["docs/adr"],
    lockedScopes: ["docs/adr/README.md"],
    protectedBranches: ["main"],
    state: "active",
    createdAt: "2026-08-25T12:00:00.000Z",
  };
  await store.create(lease);
  assert.deepEqual(await store.get(lease.leaseId), lease);
  assert.deepEqual(await store.list("example-project"), [lease]);

  const lane1 = join(stateDir, "lane1");
  const lane2 = join(stateDir, "lane2");
  await mkdir(lane1);
  await mkdir(lane2);
  const runtimeStore = new WriterLeaseStore(join(stateDir, "runtime"));
  const base = "5".repeat(40);
  const head = "6".repeat(40);
  const statusText = " M src/example_app/api/projects.py\n";
  const statusSha = hashGitStatus(statusText);
  const herdrCalls: string[][] = [];
  let currentWorktree = lane1;
  let currentName = "lane1-writer";
  const fakeGit = async (args: string[]) => {
    const cwd = args[1];
    if (args.includes("--show-toplevel")) return { stdout: `${cwd}\n`, stderr: "" };
    if (args.includes("--absolute-git-dir")) return { stdout: `${join(stateDir, "common.git", "worktrees", cwd === lane1 ? "lane1" : "lane2")}\n`, stderr: "" };
    if (args.includes("--git-common-dir")) return { stdout: `${join(stateDir, "common.git")}\n`, stderr: "" };
    if (args.includes("symbolic-ref")) {
      return { stdout: `${cwd === lane1 ? "codex/lane1" : "codex/lane2"}\n`, stderr: "" };
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD") return { stdout: `${head}\n`, stderr: "" };
    if (args.includes("merge-base")) return { stdout: "", stderr: "" };
    if (args.includes("status")) return { stdout: statusText, stderr: "" };
    throw new Error(`unexpected fake Git call: ${args.join(" ")}`);
  };
  const fakeHerdr = async (args: string[]) => {
    herdrCalls.push(args);
    if (args[0] === "agent" && args[1] === "list") {
      return { json: { result: { agents: [] } }, stdout: "", stderr: "" };
    }
    if (args[0] === "pane" && args[1] === "split") {
      currentWorktree = args[args.indexOf("--cwd") + 1];
      return { json: { result: { pane: { pane_id: "w1:p20" } } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "start") {
      currentName = args[2];
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "get") {
      return { json: { result: { agent: {
        agent: "codex",
        agent_status: "idle",
        cwd: currentWorktree,
        name: currentName,
        pane_id: "w1:p20",
        state_change_seq: 20,
      } } }, stdout: "", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "read") {
      return { stdout: "writer checkpoint complete", stderr: "" };
    }
    if (args[0] === "pane" && args[1] === "close") {
      return { json: { result: { ok: true } }, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected fake Herdr call: ${args.join(" ")}`);
  };
  const ids = [
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  ];
  const tools = createSafeWriterTools({
    herdr: fakeHerdr,
    git: fakeGit,
    store: runtimeStore,
    now: () => new Date("2026-08-25T13:00:00.000Z"),
    uuid: () => ids.shift() ?? "77777777-7777-4777-8777-777777777777",
  });
  const startTool = tools.find((tool) => tool.name === "herdr_owned_worker_start");
  const releaseTool = tools.find((tool) => tool.name === "herdr_owned_worker_release");
  assert(startTool?.run && releaseTool?.run);
  const startArgs = {
    controller_id: "example-project",
    purpose: "Implement ticket 85",
    ticket_ref: "https://github.com/example-org/research-app/issues/85",
    authority_ref: "https://github.com/example-org/research-app/issues/74",
    authority_sha256: "a".repeat(64),
    parent_pane_id: "w1:p1",
    worktree: lane1,
    branch: "codex/lane1",
    base_commit: base,
    expected_head: head,
    expected_status_sha256: statusSha,
    owned_scopes: ["src/example_app/api/projects.py"],
    locked_scopes: ["docs/CURRENT.md"],
    protected_branches: ["main"],
    name: "lane1-writer",
    kind: "codex",
  };
  await startTool.run(startArgs);
  assert.equal((await runtimeStore.get("55555555-5555-4555-8555-555555555555")).state, "active");
  await assert.rejects(
    startTool.run({
      ...startArgs,
      worktree: lane2,
      branch: "codex/lane2",
      name: "lane2-writer",
      owned_scopes: ["src/example_app/api"],
    }),
    /ownership overlaps/,
  );
  await assert.rejects(
    startTool.run({
      ...startArgs,
      worktree: lane2,
      branch: "codex/lane2",
      name: "lane2-writer",
      owned_scopes: ["docs/CURRENT.md"],
      locked_scopes: [],
    }),
    /locked scope/,
  );
  await assert.rejects(
    startTool.run({
      ...startArgs,
      worktree: lane2,
      branch: "codex/lane2",
      name: "lane2-writer",
      owned_scopes: ["tests/unit"],
      protected_branches: ["main", "codex/lane2"],
    }),
    /is protected/,
  );
  assert.equal(herdrCalls.filter((args) => args[0] === "pane" && args[1] === "split").length, 1);
  await releaseTool.run({
    lease_id: "55555555-5555-4555-8555-555555555555",
    controller_id: "example-project",
    expected_head: head,
    expected_status_sha256: statusSha,
    checkpoint_ref: "https://github.com/example-org/research-app/issues/85#issuecomment-1",
    checkpoint_sha256: "b".repeat(64),
  });
  assert.equal((await runtimeStore.get("55555555-5555-4555-8555-555555555555")).state, "released");
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("safe Herdr writer contract passed");
