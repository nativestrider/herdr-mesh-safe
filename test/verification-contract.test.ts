import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControllerLeaseStore, WriterLeaseStore, type ControllerLease, type WriterLease } from "../src/lease-store.js";
import { hashGitStatus } from "../src/tools/safe-writer.js";
import {
  createSafeVerificationTools,
  VerificationRecordStore,
  type CommandResult,
} from "../src/tools/safe-verification.js";

function hashedLock(packagePin: string, hashCharacter: string): string {
  return `${packagePin} ${String.fromCharCode(92)}\n    --hash=sha256:${hashCharacter.repeat(64)}\n`;
}

const stateDir = await mkdtemp(join(tmpdir(), "herdr-mesh-verification-test-"));
try {
  const worktree = join(stateDir, "lane");
  await mkdir(worktree);
  const writerStore = new WriterLeaseStore(join(stateDir, "writers"));
  const controllerStore = new ControllerLeaseStore(join(stateDir, "controllers"));
  const recordStore = new VerificationRecordStore(join(stateDir, "records"));
  const base = "1".repeat(40);
  const head = "2".repeat(40);
  let statusText = " M docs/example.md\n";
  let untracked = "";
  let baseRequirements = hashedLock("example==1", "a");
  const writer: WriterLease = {
    version: 1,
    leaseType: "writer",
    leaseId: "11111111-1111-4111-8111-111111111111",
    controllerId: "example",
    purpose: "Implement ticket 1",
    ticketRef: "https://example.test/issues/1",
    authorityRef: "https://example.test/issues/parent",
    authoritySha256: "a".repeat(64),
    parentPaneId: "w1:p1",
    paneId: "w1:p2",
    agentName: "example_writer",
    agentKind: "codex",
    repositoryRoot: worktree,
    gitDir: join(stateDir, "common.git", "worktrees", "lane"),
    gitCommonDir: join(stateDir, "common.git"),
    worktree,
    branch: "codex/example",
    baseCommit: base,
    headCommit: head,
    gitStatusSha256: hashGitStatus(statusText),
    ownedScopes: ["docs/example.md"],
    lockedScopes: [],
    protectedBranches: ["main"],
    state: "active",
    createdAt: "2026-08-25T12:00:00.000Z",
  };
  const controller: ControllerLease = {
    version: 1,
    leaseType: "controller",
    leaseId: "22222222-2222-4222-8222-222222222222",
    controllerId: "example",
    fenceToken: "33333333-3333-4333-8333-333333333333",
    generation: 1,
    authorityRef: "https://example.test/issues/parent",
    authoritySha256: "a".repeat(64),
    paneId: "w1:p1",
    agentName: "example_coordinator",
    agentKind: "codex",
    cwd: stateDir,
    state: "active",
    acquiredAt: "2026-08-25T12:00:00.000Z",
    renewedAt: "2026-08-25T12:00:00.000Z",
    expiresAt: "2026-08-25T14:00:00.000Z",
  };
  await writerStore.create(writer);
  await controllerStore.create(controller);

  const git = async (args: string[]) => {
    if (args.includes("symbolic-ref")) return { stdout: `${writer.branch}\n`, stderr: "" };
    if (args[2] === "rev-parse" && args[3] === "HEAD") return { stdout: `${head}\n`, stderr: "" };
    if (args.includes("merge-base")) return { stdout: "", stderr: "" };
    if (args.includes("status")) return { stdout: statusText, stderr: "" };
    if (args.includes("show")) return { stdout: baseRequirements, stderr: "" };
    if (args.includes("diff")) return { stdout: "diff --git a/docs/example.md b/docs/example.md\n", stderr: "" };
    if (args.includes("ls-files")) return { stdout: untracked, stderr: "" };
    throw new Error(`unexpected Git call: ${args.join(" ")}`);
  };
  const herdr = async (args: string[]) => {
    assert.deepEqual(args.slice(0, 3), ["agent", "get", writer.agentName]);
    return {
      json: { result: { agent: {
        agent: writer.agentKind,
        agent_status: "done",
        cwd: worktree,
        name: writer.agentName,
        pane_id: writer.paneId,
        state_change_seq: 10,
      } } },
      stdout: "",
      stderr: "",
    };
  };
  let planGate = "check-authority";
  let planOutput: string | undefined;
  let expireDuringGate = false;
  const commandCalls: string[][] = [];
  const commandEnvironments: NodeJS.ProcessEnv[] = [];
  const commandTimeouts: number[] = [];
  const commandRunIds: string[] = [];
  const commandReadOnlyFiles: Array<Array<{ source: string; destination: string }> | undefined> = [];
  let requirementsChangeDuringPlan: string | undefined;
  const command = async (
    executable: string,
    args: string[],
    options: {
      environment: NodeJS.ProcessEnv;
      timeoutMs: number;
      runId: string;
      readOnlyFiles?: Array<{ source: string; destination: string }>;
    },
  ): Promise<CommandResult> => {
    const argv = [executable, ...args];
    commandCalls.push(argv);
    commandEnvironments.push(options.environment);
    commandTimeouts.push(options.timeoutMs);
    commandRunIds.push(options.runId);
    commandReadOnlyFiles.push(options.readOnlyFiles);
    const isPlan = args.includes("verification-plan");
    if (isPlan && requirementsChangeDuringPlan !== undefined) {
      await writeFile(join(worktree, "requirements.lock"), requirementsChangeDuringPlan);
    }
    const stdoutTail = isPlan
      ? planOutput ?? `Verification class: authority\nMinimum final gate: just ${planGate}\n`
      : "6 passed\n";
    if (expireDuringGate && !isPlan && executable === "uv") {
      now = new Date("2026-08-25T14:00:01.000Z");
    }
    return {
      argv,
      durationMs: 10,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdoutTail,
      stderrTail: "",
      stdoutSha256: "b".repeat(64),
      stderrSha256: "c".repeat(64),
    };
  };
  let now = new Date("2026-08-25T13:00:00.000Z");
  const verificationDependencies = {
    git,
    herdr,
    writers: writerStore,
    records: recordStore,
    controller: {
      store: controllerStore,
      now: () => now,
      callerPaneId: controller.paneId,
    },
    command,
    now: () => now,
    uuid: () => "44444444-4444-4444-8444-444444444444",
    stateDir,
  };
  const tools = createSafeVerificationTools(verificationDependencies);
  const snapshotTool = tools.find((tool) => tool.name === "herdr_owned_worker_verification_snapshot");
  const verifyTool = tools.find((tool) => tool.name === "herdr_owned_worker_verify");
  const listTool = tools.find((tool) => tool.name === "herdr_owned_worker_verification_list");
  assert(snapshotTool?.run && verifyTool?.run && listTool?.run);
  const common = {
    controller_id: controller.controllerId,
    lease_id: writer.leaseId,
    base_commit: base,
    expected_head: head,
    expected_status_sha256: hashGitStatus(statusText),
  };
  const snapshot = JSON.parse((await snapshotTool.run(common)).content[0].text);
  assert.match(snapshot.worktreeSha256, /^[0-9a-f]{64}$/);
  const passed = JSON.parse((await verifyTool.run({
    ...common,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    expected_worktree_sha256: snapshot.worktreeSha256,
  })).content[0].text);
  assert.equal(passed.record.state, "passed");
  assert.equal(passed.record.selectedGate, "check-authority");
  assert.deepEqual(commandCalls[0], ["uv", "run", "just", "verification-plan", "--base", base]);
  assert.deepEqual(commandCalls[1], ["uv", "run", "just", "check-authority"]);

  await mkdir(join(worktree, "web"));
  await writeFile(join(worktree, "web", "package-lock.json"), "{}\n");
  await writeFile(join(worktree, "requirements.lock"), baseRequirements);
  statusText += "?? web/package-lock.json\n";
  untracked = "web/package-lock.json\0";
  planGate = "check-fast";
  now = new Date("2026-08-25T13:01:00.000Z");
  const webCommon = { ...common, expected_status_sha256: hashGitStatus(statusText) };
  const webSnapshot = JSON.parse((await snapshotTool.run(webCommon)).content[0].text);
  const preflight = JSON.parse((await verifyTool.run({
    ...webCommon,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    expected_worktree_sha256: webSnapshot.worktreeSha256,
  })).content[0].text);
  assert.equal(preflight.record.state, "preflight_failed");
  assert.match(preflight.record.failure, /bootstrap_web=true/);
  assert.equal(commandCalls.length, 3, "preflight must not start the final gate");

  now = new Date("2026-08-25T13:02:00.000Z");
  const bootstrapped = JSON.parse((await verifyTool.run({
    ...webCommon,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    expected_worktree_sha256: webSnapshot.worktreeSha256,
    bootstrap_web: true,
    bootstrap_python_locks: ["requirements.lock"],
  })).content[0].text);
  assert.equal(bootstrapped.record.state, "passed", JSON.stringify(bootstrapped));
  assert.deepEqual(commandCalls[4], [
    "mise", "exec", "node@22.22.2", "--", "npm", "--prefix", "web", "ci", "--ignore-scripts",
  ]);
  assert.equal(commandEnvironments[4].npm_config_ignore_scripts, "true");
  assert.deepEqual(commandCalls[5].slice(0, 9), [
    "uv", "pip", "install", "--require-hashes", "--no-build", "--no-config", "--target",
    commandCalls[5][7], "--requirements",
  ]);
  assert.match(commandCalls[5][7], /^\/gate-home\/python-bootstrap\/[0-9a-f]{64}$/);
  assert.match(commandCalls[5][9], /^\/gate-inputs\/[0-9a-f]{64}-requirements\.lock$/);
  assert.equal(commandReadOnlyFiles[5]?.[0]?.destination, commandCalls[5][9]);
  assert.match(commandReadOnlyFiles[5]?.[0]?.source ?? "", /\/gate-inputs\/[0-9a-f]{64}\/[0-9a-f]{64}-requirements\.lock$/);
  assert.equal(commandEnvironments[5].UV_OFFLINE, undefined);
  assert.deepEqual(commandCalls[6], ["uv", "run", "just", "check-fast"]);
  assert.deepEqual(bootstrapped.record.bootstrapPythonLocks, ["requirements.lock"]);

  await mkdir(join(worktree, "copy"));
  await writeFile(join(worktree, "copy", "requirements.lock"), baseRequirements);
  now = new Date("2026-08-25T13:02:05.000Z");
  const commandsBeforeDuplicateLocks = commandCalls.length;
  const duplicateLocks = JSON.parse((await verifyTool.run({
    ...webCommon,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    expected_worktree_sha256: webSnapshot.worktreeSha256,
    bootstrap_web: true,
    bootstrap_python_locks: ["requirements.lock", "copy/requirements.lock"],
  })).content[0].text);
  assert.equal(duplicateLocks.record.state, "passed", JSON.stringify(duplicateLocks));
  assert.notEqual(
    commandCalls[commandsBeforeDuplicateLocks + 2][9],
    commandCalls[commandsBeforeDuplicateLocks + 3][9],
  );

  await assert.rejects(
    verifyTool.run({
      ...webCommon,
      controller_lease_id: controller.leaseId,
      controller_fence_token: controller.fenceToken,
      expected_worktree_sha256: webSnapshot.worktreeSha256,
      bootstrap_python_locks: ["../requirements.lock"],
    }),
    /stay inside the lane worktree/,
  );
  now = new Date("2026-08-25T13:02:10.000Z");
  requirementsChangeDuringPlan = hashedLock("tampered==1", "b");
  const racedManifest = JSON.parse((await verifyTool.run({
    ...webCommon,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    expected_worktree_sha256: webSnapshot.worktreeSha256,
    bootstrap_web: true,
    bootstrap_python_locks: ["requirements.lock"],
  })).content[0].text);
  assert.equal(racedManifest.record.state, "preflight_failed");
  assert.match(racedManifest.record.failure, /differs from the accepted base commit/);
  requirementsChangeDuringPlan = undefined;
  now = new Date("2026-08-25T13:02:20.000Z");
  await writeFile(join(worktree, "requirements.lock"), `${baseRequirements}\n`);
  const trailingByteDrift = JSON.parse((await verifyTool.run({
    ...webCommon,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    expected_worktree_sha256: webSnapshot.worktreeSha256,
    bootstrap_web: true,
    bootstrap_python_locks: ["requirements.lock"],
  })).content[0].text);
  assert.equal(trailingByteDrift.record.state, "preflight_failed");
  assert.match(trailingByteDrift.record.failure, /differs from the accepted base commit/);
  now = new Date("2026-08-25T13:02:30.000Z");
  baseRequirements = hashedLock("-r other.txt", "c");
  await writeFile(join(worktree, "requirements.lock"), baseRequirements);
  const indirectManifest = JSON.parse((await verifyTool.run({
    ...webCommon,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    expected_worktree_sha256: webSnapshot.worktreeSha256,
    bootstrap_web: true,
    bootstrap_python_locks: ["requirements.lock"],
  })).content[0].text);
  assert.equal(indirectManifest.record.state, "preflight_failed");
  assert.match(indirectManifest.record.failure, /one exact registry pin with SHA-256 hashes/);
  baseRequirements = hashedLock("example==1", "a");
  await writeFile(join(worktree, "requirements.lock"), baseRequirements);

  planOutput = "Minimum final gate: just check-fast\nMinimum final gate: just check-docs\n";
  now = new Date("2026-08-25T13:03:00.000Z");
  const commandsBeforeAmbiguousPlan = commandCalls.length;
  const ambiguousPlan = JSON.parse((await verifyTool.run({
    ...webCommon,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    expected_worktree_sha256: webSnapshot.worktreeSha256,
    bootstrap_web: true,
  })).content[0].text);
  assert.equal(ambiguousPlan.record.state, "preflight_failed");
  assert.match(ambiguousPlan.record.failure, /exactly one minimum final gate/);
  assert.equal(
    commandCalls.length,
    commandsBeforeAmbiguousPlan + 1,
    "an ambiguous plan must not start bootstrap or the final gate",
  );

  planOutput = undefined;
  planGate = "check-authority";
  expireDuringGate = true;
  now = new Date("2026-08-25T13:59:00.000Z");
  const expiringSnapshot = JSON.parse((await snapshotTool.run(webCommon)).content[0].text);
  const expiredFence = JSON.parse((await verifyTool.run({
    ...webCommon,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    expected_worktree_sha256: expiringSnapshot.worktreeSha256,
  })).content[0].text);
  assert.equal(expiredFence.record.state, "invalidated");
  assert.match(expiredFence.record.failure, /controller fence became invalid/);
  assert.equal(commandTimeouts.at(-1), 55_000);
  assert(commandRunIds.every((runId) => /^[0-9a-f]{64}$/.test(runId)));
  assert(new Set(commandRunIds).size > 1, "separate verification runs must use separate sandbox identities");

  const unsupportedTools = createSafeVerificationTools({
    ...verificationDependencies,
    platform: "darwin",
    executableAvailable: async () => true,
  });
  const unsupportedVerify = unsupportedTools.find((tool) => tool.name === "herdr_owned_worker_verify");
  assert(unsupportedVerify?.run);
  await assert.rejects(unsupportedVerify.run({
    ...webCommon,
    controller_lease_id: controller.leaseId,
    controller_fence_token: controller.fenceToken,
    expected_worktree_sha256: expiringSnapshot.worktreeSha256,
  }), /host verification requires Linux/);

  const records = JSON.parse((await listTool.run({ controller_id: "example" })).content[0].text).records;
  assert.equal(records.length, 9);
  assert.equal("stdoutTail" in records[0], false);
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("safe host verification contract passed");
