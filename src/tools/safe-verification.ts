import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, lstat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { runGit, type GitResult } from "../git.js";
import { runHerdr, type HerdrResult } from "../herdr.js";
import { WriterLeaseStore, type WriterLease } from "../lease-store.js";
import { extractAgentSnapshot } from "./safe-agent.js";
import {
  assertControllerAuthority,
  controllerCredentials,
  defaultControllerAuthorityDependencies,
  type ControllerAuthorityDependencies,
} from "./safe-controller.js";
import { hashGitStatus } from "./safe-writer.js";
import { ok, type ToolDef } from "./types.js";

const SHA = /^[0-9a-f]{40,64}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_OUTPUT_TAIL = 32 * 1024;

type GitRunner = (args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<GitResult>;
type HerdrRunner = (args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<HerdrResult>;

export interface CommandResult {
  argv: string[];
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  stdoutSha256: string;
  stderrSha256: string;
}

type CommandRunner = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    gitCommonDir: string;
    stateDir: string;
    allowNetwork: boolean;
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
    runId: string;
    readOnlyFiles?: Array<{ source: string; destination: string }>;
  },
) => Promise<CommandResult>;

export type VerificationState =
  | "running"
  | "passed"
  | "failed"
  | "timed_out"
  | "preflight_failed"
  | "invalidated";

export interface VerificationRecord {
  version: 1;
  runId: string;
  controllerId: string;
  controllerGeneration: number;
  writerLeaseId: string;
  ticketRef: string;
  worktree: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  worktreeSha256: string;
  selectedGate?: string;
  bootstrapWeb: boolean;
  bootstrapPythonLocks?: string[];
  state: VerificationState;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  command?: string[];
  stdoutSha256?: string;
  stderrSha256?: string;
  afterWorktreeSha256?: string;
  failure?: string;
}

export class VerificationRecordStore {
  readonly directory: string;

  constructor(stateDir = process.env.HERDR_MESH_STATE_DIR ?? join(homedir(), ".local", "state", "herdr-mesh")) {
    this.directory = join(stateDir, "verification-runs");
  }

  async create(record: VerificationRecord): Promise<void> {
    await this.ensureDirectory();
    await writeFile(this.pathFor(record.runId), this.serialize(record), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }

  async update(record: VerificationRecord): Promise<void> {
    await this.ensureDirectory();
    const destination = this.pathFor(record.runId);
    await readFile(destination, "utf8");
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, this.serialize(record), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  }

  async list(controllerId?: string, writerLeaseId?: string): Promise<VerificationRecord[]> {
    await this.ensureDirectory();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    const records: VerificationRecord[] = [];
    for (const name of names) {
      const record = this.parse(await readFile(join(this.directory, name), "utf8"));
      if (controllerId && record.controllerId !== controllerId) continue;
      if (writerLeaseId && record.writerLeaseId !== writerLeaseId) continue;
      records.push(record);
    }
    return records;
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private pathFor(runId: string): string {
    if (!SHA256.test(runId)) throw new Error("invalid verification run id");
    return join(this.directory, `${runId}.json`);
  }

  private serialize(record: VerificationRecord): string {
    return `${JSON.stringify(record, null, 2)}\n`;
  }

  private parse(raw: string): VerificationRecord {
    const record = JSON.parse(raw) as VerificationRecord;
    if (record.version !== 1 || !SHA256.test(record.runId)) {
      throw new Error("invalid verification record");
    }
    return record;
  }
}

interface WorkerSnapshot {
  lease: WriterLease;
  headCommit: string;
  gitStatusSha256: string;
  worktreeSha256: string;
}

export interface SafeVerificationDependencies {
  git: GitRunner;
  herdr: HerdrRunner;
  writers: WriterLeaseStore;
  records: VerificationRecordStore;
  controller: ControllerAuthorityDependencies;
  command: CommandRunner;
  now: () => Date;
  uuid: () => string;
  stateDir: string;
  platform?: NodeJS.Platform;
  executableAvailable?: (name: string) => Promise<boolean>;
}

const defaultStateDir = process.env.HERDR_MESH_STATE_DIR ?? join(homedir(), ".local", "state", "herdr-mesh");
const defaultDependencies: SafeVerificationDependencies = {
  git: runGit,
  herdr: runHerdr,
  writers: new WriterLeaseStore(),
  records: new VerificationRecordStore(),
  controller: defaultControllerAuthorityDependencies,
  command: runSandboxedCommand,
  now: () => new Date(),
  uuid: randomUUID,
  stateDir: defaultStateDir,
  platform: process.platform,
  executableAvailable: async (name) => {
    if (name !== "bwrap") return false;
    try {
      await access("/usr/bin/bwrap", constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

function appendTail(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString("utf8");
  return combined.length <= MAX_OUTPUT_TAIL ? combined : combined.slice(-MAX_OUTPUT_TAIL);
}

export async function runCommand(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; environment: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise<CommandResult>((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let stdoutTail = "";
    let stderrTail = "";
    let timedOut = false;
    let forcedKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // The process group already exited.
        }
      }
      forcedKill = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // The process group already exited.
          }
        }
      }, 2_000);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutHash.update(chunk);
      stdoutTail = appendTail(stdoutTail, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrHash.update(chunk);
      stderrTail = appendTail(stderrTail, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forcedKill) clearTimeout(forcedKill);
      rejectCommand(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forcedKill) clearTimeout(forcedKill);
      resolveCommand({
        argv: [executable, ...args],
        durationMs: Date.now() - startedAt,
        exitCode,
        signal,
        timedOut,
        stdoutTail,
        stderrTail,
        stdoutSha256: stdoutHash.digest("hex"),
        stderrSha256: stderrHash.digest("hex"),
      });
    });
  });
}

function addDestinationParents(args: string[], destinations: string[]): void {
  const directories = new Set<string>();
  for (const destination of destinations) {
    let current = dirname(destination);
    while (current !== "/") {
      if (!["/usr", "/etc", "/proc", "/dev", "/tmp"].includes(current)) directories.add(current);
      current = dirname(current);
    }
  }
  for (const directory of [...directories].sort((left, right) => left.split(sep).length - right.split(sep).length)) {
    args.push("--dir", directory);
  }
}

export function buildNetworkResolverBindArgs(resolverPath: string): string[] {
  if (!isAbsolute(resolverPath)) throw new Error("network resolver path must be absolute");
  if (
    resolverPath === "/etc/resolv.conf" || resolverPath.startsWith("/etc/") ||
    resolverPath.startsWith("/usr/")
  ) {
    return [];
  }
  const args: string[] = [];
  addDestinationParents(args, [resolverPath]);
  args.push("--ro-bind", resolverPath, resolverPath);
  return args;
}

export async function runSandboxedCommand(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    gitCommonDir: string;
    stateDir: string;
    allowNetwork: boolean;
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
    runId: string;
    readOnlyFiles?: Array<{ source: string; destination: string }>;
  },
): Promise<CommandResult> {
  const sandboxHome = join(options.stateDir, "gate-sandbox-homes", options.runId);
  await mkdir(sandboxHome, { recursive: true, mode: 0o700 });
  const localBin = join(homedir(), ".local", "bin");
  const uvData = join(homedir(), ".local", "share", "uv");
  const miseData = join(homedir(), ".local", "share", "mise");
  const bubblewrapArgs = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
  ];
  if (!options.allowNetwork) bubblewrapArgs.push("--unshare-net");
  bubblewrapArgs.push(
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--ro-bind", "/etc", "/etc",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  );
  if (options.allowNetwork) {
    bubblewrapArgs.push(...buildNetworkResolverBindArgs(await realpath("/etc/resolv.conf")));
  }
  addDestinationParents(bubblewrapArgs, [options.cwd, options.gitCommonDir, localBin, uvData, miseData]);
  addDestinationParents(
    bubblewrapArgs,
    (options.readOnlyFiles ?? []).map((file) => file.destination),
  );
  bubblewrapArgs.push(
    "--bind", options.cwd, options.cwd,
    "--ro-bind", options.gitCommonDir, options.gitCommonDir,
    "--ro-bind", localBin, localBin,
    "--ro-bind", uvData, uvData,
    "--ro-bind", miseData, miseData,
    "--bind", sandboxHome, "/gate-home",
    "--clearenv",
  );
  for (const file of options.readOnlyFiles ?? []) {
    bubblewrapArgs.push("--ro-bind", file.source, file.destination);
  }
  for (const [key, value] of Object.entries(options.environment)) {
    if (value !== undefined) bubblewrapArgs.push("--setenv", key, value);
  }
  bubblewrapArgs.push("--chdir", options.cwd, executable, ...args);
  const result = await runCommand("bwrap", bubblewrapArgs, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    environment: options.environment,
  });
  return { ...result, argv: [executable, ...args] };
}

function commandEnvironment(stateDir: string, allowNetwork: boolean): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL", "TERM"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  environment.PATH = [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".local", "share", "mise", "installs", "node", "22.22.2", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  environment.HOME = "/gate-home";
  environment.TMPDIR = "/tmp";
  environment.XDG_RUNTIME_DIR = "/tmp";
  environment.CI = "1";
  environment.NO_COLOR = "1";
  environment.PYTHONDONTWRITEBYTECODE = "1";
  environment.UV_CACHE_DIR = "/gate-home/.cache/uv";
  environment.MISE_CACHE_DIR = "/gate-home/.cache/mise";
  environment.MISE_CONFIG_DIR = "/gate-home/.config/mise";
  environment.MISE_DATA_DIR = join(homedir(), ".local", "share", "mise");
  environment.npm_config_audit = "false";
  environment.npm_config_fund = "false";
  environment.npm_config_ignore_scripts = "true";
  if (!allowNetwork) environment.UV_OFFLINE = "1";
  return environment;
}

function safeRequirementsLockPath(value: string): string {
  if (!value || value !== value.trim() || isAbsolute(value) || value.includes("\\")) {
    throw new Error("Python bootstrap lock path must be a clean relative POSIX path");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Python bootstrap lock path must stay inside the lane worktree");
  }
  if (parts.at(-1) !== "requirements.lock") {
    throw new Error("Python bootstrap accepts only requirements.lock manifests");
  }
  return parts.join("/");
}

function assertHashLockedRequirements(contents: string): void {
  const pinned = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?==[A-Za-z0-9][A-Za-z0-9.!+_-]*(?:\s*;\s*[A-Za-z0-9_ .'"()!<>=-]+)?$/;
  const hash = /(?:^|\s)--hash=sha256:[0-9a-f]{64}(?=\s|$)/g;
  let requirementCount = 0;
  let logical = "";
  for (const [index, rawLine] of contents.split("\n").entries()) {
    const line = rawLine.trim();
    if (!logical && (!line || line.startsWith("#"))) continue;
    const continues = line.endsWith("\\");
    logical += `${logical ? " " : ""}${continues ? line.slice(0, -1).trimEnd() : line}`;
    if (continues) continue;
    const hashes = logical.match(hash) ?? [];
    const requirement = logical.replace(hash, " ").replace(/\s+/g, " ").trim();
    if (!pinned.test(requirement) || hashes.length === 0) {
      throw new Error(
        `Python bootstrap lock entry ending at line ${index + 1} must be one exact registry pin with SHA-256 hashes`,
      );
    }
    requirementCount += 1;
    logical = "";
  }
  if (logical || requirementCount === 0) {
    throw new Error("Python bootstrap lock must contain complete hash-pinned entries");
  }
}

async function materializeBaseRequirementsLock(
  git: GitRunner,
  worktree: string,
  baseCommit: string,
  lockPath: string,
  stateDir: string,
  runId: string,
): Promise<{ source: string; destination: string }> {
  const absolutePath = resolve(worktree, lockPath);
  const root = `${resolve(worktree)}${sep}`;
  if (!absolutePath.startsWith(root)) {
    throw new Error("Python bootstrap lock path escapes the lane worktree");
  }
  if (await realpath(absolutePath) !== absolutePath) {
    throw new Error("Python bootstrap lock path must not traverse symlinks");
  }
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Python bootstrap lock must be a regular file");
  }
  const committed = (await git([
    "-C", worktree, "show", `${baseCommit}:${lockPath}`,
  ])).stdout;
  const current = await readFile(absolutePath, "utf8");
  if (current !== committed) {
    throw new Error("Python bootstrap lock differs from the accepted base commit");
  }
  assertHashLockedRequirements(committed);
  const digest = createHash("sha256").update(`${lockPath}\0${committed}`).digest("hex");
  const inputDirectory = join(stateDir, "gate-inputs", runId);
  await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
  const source = join(inputDirectory, `${digest}-requirements.lock`);
  await writeFile(source, committed, { encoding: "utf8", flag: "wx", mode: 0o400 });
  return { source, destination: `/gate-inputs/${digest}-requirements.lock` };
}

async function gitText(git: GitRunner, args: string[]): Promise<string> {
  return (await git(args, { timeoutMs: 30_000 })).stdout.trim();
}

async function worktreeDigest(git: GitRunner, worktree: string, baseCommit: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update("herdr-worktree-v1\0");
  const tracked = (await git([
    "-C", worktree, "diff", "--binary", "--full-index", "--no-ext-diff", baseCommit, "--",
  ], { timeoutMs: 30_000 })).stdout;
  hash.update("tracked\0");
  hash.update(tracked);
  const untracked = (await git([
    "-C", worktree, "ls-files", "--others", "--exclude-standard", "-z",
  ], { timeoutMs: 30_000 })).stdout.split("\0").filter(Boolean).sort();
  for (const relative of untracked) {
    const absolute = resolve(worktree, relative);
    if (!absolute.startsWith(`${worktree}${sep}`)) throw new Error("untracked path escapes the writer worktree");
    const metadata = await lstat(absolute);
    hash.update("untracked\0");
    hash.update(relative);
    hash.update("\0");
    if (metadata.isSymbolicLink()) {
      hash.update("symlink\0");
      hash.update(await readlink(absolute));
    } else if (metadata.isFile()) {
      hash.update("file\0");
      hash.update(await readFile(absolute));
    } else {
      throw new Error(`unsupported untracked path type: ${relative}`);
    }
  }
  return hash.digest("hex");
}

async function inspectWorker(
  dependencies: SafeVerificationDependencies,
  controllerId: string,
  writerLeaseId: string,
  baseCommit: string,
  expectedHead: string,
  expectedStatusSha256: string,
): Promise<WorkerSnapshot> {
  const lease = await dependencies.writers.get(writerLeaseId);
  if (lease.controllerId !== controllerId) throw new Error("writer lease belongs to a different controller");
  if (lease.state !== "active") throw new Error(`writer lease is ${lease.state}, not active`);
  if (lease.baseCommit !== baseCommit) throw new Error("verification base does not match the writer lease");
  const worktree = await realpath(lease.worktree);
  if (worktree !== lease.worktree) throw new Error("writer worktree identity changed");
  const snapshot = extractAgentSnapshot((await dependencies.herdr([
    "agent", "get", lease.agentName,
  ], { timeoutMs: 30_000 })).json);
  if (
    snapshot.paneId !== lease.paneId || snapshot.name !== lease.agentName ||
    snapshot.kind !== lease.agentKind || !snapshot.cwd || resolve(snapshot.cwd) !== resolve(lease.worktree)
  ) {
    throw new Error("writer identity no longer matches its lease");
  }
  if (snapshot.status !== "idle" && snapshot.status !== "done") {
    throw new Error(`writer is ${snapshot.status}; verification requires settled bytes`);
  }
  const branch = await gitText(dependencies.git, ["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== lease.branch) throw new Error(`writer branch is ${branch}, expected ${lease.branch}`);
  const headCommit = await gitText(dependencies.git, ["-C", worktree, "rev-parse", "HEAD"]);
  if (headCommit !== expectedHead) throw new Error(`writer HEAD is ${headCommit}, expected ${expectedHead}`);
  await dependencies.git(["-C", worktree, "merge-base", "--is-ancestor", baseCommit, headCommit], { timeoutMs: 30_000 });
  const status = (await dependencies.git([
    "-C", worktree, "status", "--porcelain=v1", "--untracked-files=all",
  ], { timeoutMs: 30_000 })).stdout;
  const gitStatusSha256 = hashGitStatus(status);
  if (gitStatusSha256 !== expectedStatusSha256) {
    throw new Error(`writer git status digest is ${gitStatusSha256}, expected ${expectedStatusSha256}`);
  }
  return {
    lease,
    headCommit,
    gitStatusSha256,
    worktreeSha256: await worktreeDigest(dependencies.git, worktree, baseCommit),
  };
}

function selectedGate(output: string): string {
  const matches = [...output.matchAll(/^Minimum final gate: just ([A-Za-z0-9_-]+)$/gm)];
  if (matches.length !== 1) throw new Error("verification-plan did not report exactly one minimum final gate");
  return matches[0][1];
}

function gateNeedsWeb(gate: string): boolean {
  return gate !== "check-docs" && gate !== "check-authority";
}

function gateAllowedOnLocalRunner(gate: string): boolean {
  return gate === "check-docs" || gate === "check-authority" || gate === "check-fast";
}

async function webDependenciesReady(worktree: string): Promise<boolean> {
  try {
    await access(join(worktree, "web", "node_modules", ".bin", "tsc"), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function hasWebLock(worktree: string): Promise<boolean> {
  try {
    return (await stat(join(worktree, "web", "package-lock.json"))).isFile();
  } catch {
    return false;
  }
}

function resultState(result: CommandResult): VerificationState {
  if (result.timedOut) return "timed_out";
  return result.exitCode === 0 ? "passed" : "failed";
}

async function finishRecord(
  dependencies: SafeVerificationDependencies,
  record: VerificationRecord,
  update: Partial<VerificationRecord>,
): Promise<VerificationRecord> {
  const completed: VerificationRecord = {
    ...record,
    ...update,
    completedAt: dependencies.now().toISOString(),
  };
  await dependencies.records.update(completed);
  return completed;
}

interface VerificationAuthority {
  controllerId: string;
  controllerLeaseId: string;
  controllerFenceToken: string;
}

async function finishFencedRecord(
  dependencies: SafeVerificationDependencies,
  record: VerificationRecord,
  authority: VerificationAuthority,
  update: Partial<VerificationRecord>,
): Promise<VerificationRecord> {
  let finalUpdate = update;
  try {
    const active = await assertControllerAuthority(
      dependencies.controller,
      authority.controllerId,
      authority.controllerLeaseId,
      authority.controllerFenceToken,
    );
    if (active.generation !== record.controllerGeneration) {
      throw new Error("controller generation changed during verification");
    }
  } catch (error) {
    finalUpdate = {
      ...update,
      state: "invalidated",
      failure: `controller fence became invalid during verification: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return finishRecord(dependencies, record, finalUpdate);
}

function boundedCommandTimeout(controllerExpiresAt: string, now: Date, requestedMs: number): number {
  const available = Date.parse(controllerExpiresAt) - now.getTime() - 5_000;
  if (available <= 0) throw new Error("controller lease has too little time remaining for verification");
  return Math.min(requestedMs, available);
}

export function createSafeVerificationTools(dependencies = defaultDependencies): ToolDef[] {
  return [
    {
      name: "herdr_owned_worker_verification_snapshot",
      description: "Return the exact settled writer identity, Git status digest, and content digest used to authorize a host verification. This is read-only and executes no repository code.",
      inputSchema: {
        controller_id: z.string().min(1).max(100),
        lease_id: z.string().uuid(),
        base_commit: z.string().regex(SHA),
        expected_head: z.string().regex(SHA),
        expected_status_sha256: z.string().regex(SHA256),
      },
      run: async (args) => {
        const snapshot = await inspectWorker(
          dependencies,
          String(args.controller_id),
          String(args.lease_id),
          String(args.base_commit),
          String(args.expected_head),
          String(args.expected_status_sha256),
        );
        return ok(JSON.stringify({
          controllerId: snapshot.lease.controllerId,
          writerLeaseId: snapshot.lease.leaseId,
          ticketRef: snapshot.lease.ticketRef,
          branch: snapshot.lease.branch,
          baseCommit: snapshot.lease.baseCommit,
          headCommit: snapshot.headCommit,
          gitStatusSha256: snapshot.gitStatusSha256,
          worktreeSha256: snapshot.worktreeSha256,
        }, null, 2));
      },
    },
    {
      name: "herdr_owned_worker_verify",
      description: "Run the repository-selected verification gate on the host for one settled leased writer. Commands are fixed, controller-fenced, digest-pinned, time-bounded, and recorded. Optional dependency bootstraps accept only npm ci or unchanged, fully hash-pinned requirements.lock manifests from the accepted base commit.",
      inputSchema: {
        ...controllerCredentials,
        lease_id: z.string().uuid(),
        base_commit: z.string().regex(SHA),
        expected_head: z.string().regex(SHA),
        expected_status_sha256: z.string().regex(SHA256),
        expected_worktree_sha256: z.string().regex(SHA256),
        bootstrap_web: z.boolean().optional(),
        bootstrap_python_locks: z.array(z.string().max(256)).max(8).optional(),
        timeout_seconds: z.number().int().min(60).max(7200).optional(),
      },
      run: async (args) => {
        if ((dependencies.platform ?? process.platform) !== "linux") {
          throw new Error("host verification requires Linux and Bubblewrap");
        }
        const executableAvailable = dependencies.executableAvailable ?? defaultDependencies.executableAvailable;
        if (!executableAvailable || !await executableAvailable("bwrap")) {
          throw new Error("host verification requires Linux and the bwrap executable");
        }
        const authority: VerificationAuthority = {
          controllerId: String(args.controller_id),
          controllerLeaseId: String(args.controller_lease_id),
          controllerFenceToken: String(args.controller_fence_token),
        };
        const controller = await assertControllerAuthority(
          dependencies.controller,
          authority.controllerId,
          authority.controllerLeaseId,
          authority.controllerFenceToken,
        );
        const snapshot = await inspectWorker(
          dependencies,
          String(args.controller_id),
          String(args.lease_id),
          String(args.base_commit),
          String(args.expected_head),
          String(args.expected_status_sha256),
        );
        if (snapshot.worktreeSha256 !== String(args.expected_worktree_sha256)) {
          throw new Error("writer content digest changed before verification");
        }
        const pythonLocks = [
          ...new Set(((args.bootstrap_python_locks as string[] | undefined) ?? [])
            .map(safeRequirementsLockPath)),
        ];
        const startedAt = dependencies.now();
        const runId = createHash("sha256").update(`${dependencies.uuid()}\0${startedAt.toISOString()}`).digest("hex");
        const record: VerificationRecord = {
          version: 1,
          runId,
          controllerId: snapshot.lease.controllerId,
          controllerGeneration: controller.generation,
          writerLeaseId: snapshot.lease.leaseId,
          ticketRef: snapshot.lease.ticketRef,
          worktree: snapshot.lease.worktree,
          branch: snapshot.lease.branch,
          baseCommit: snapshot.lease.baseCommit,
          headCommit: snapshot.headCommit,
          worktreeSha256: snapshot.worktreeSha256,
          bootstrapWeb: Boolean(args.bootstrap_web),
          bootstrapPythonLocks: pythonLocks,
          state: "running",
          startedAt: startedAt.toISOString(),
        };
        await dependencies.records.create(record);
        let phase: "preflight" | "gate" | "postgate" = "preflight";
        try {
        const plan = await dependencies.command(
          "uv",
          ["run", "just", "verification-plan", "--base", snapshot.lease.baseCommit],
          {
            cwd: snapshot.lease.worktree,
            gitCommonDir: snapshot.lease.gitCommonDir,
            stateDir: dependencies.stateDir,
            allowNetwork: false,
            timeoutMs: boundedCommandTimeout(controller.expiresAt, dependencies.now(), 120_000),
            environment: commandEnvironment(dependencies.stateDir, false),
            runId,
          },
        );
        if (plan.timedOut || plan.exitCode !== 0) {
          const completed = await finishFencedRecord(dependencies, record, authority, {
            state: plan.timedOut ? "timed_out" : "failed",
            durationMs: plan.durationMs,
            exitCode: plan.exitCode,
            command: plan.argv,
            stdoutSha256: plan.stdoutSha256,
            stderrSha256: plan.stderrSha256,
            failure: "verification-plan did not complete successfully",
          });
          return ok(JSON.stringify({ record: completed, stdoutTail: plan.stdoutTail, stderrTail: plan.stderrTail }, null, 2));
        }
        let gate: string;
        try {
          gate = selectedGate(plan.stdoutTail);
        } catch (error) {
          const completed = await finishFencedRecord(dependencies, record, authority, {
            state: "preflight_failed",
            durationMs: dependencies.now().getTime() - startedAt.getTime(),
            command: plan.argv,
            stdoutSha256: plan.stdoutSha256,
            stderrSha256: plan.stderrSha256,
            failure: error instanceof Error ? error.message : String(error),
          });
          return ok(JSON.stringify({ record: completed }, null, 2));
        }
        record.selectedGate = gate;
        await dependencies.records.update(record);
        if (!gateAllowedOnLocalRunner(gate)) {
          const completed = await finishFencedRecord(dependencies, record, authority, {
            state: "preflight_failed",
            durationMs: dependencies.now().getTime() - startedAt.getTime(),
            failure: `selected gate ${gate} requires CI or a separately authorized external runner`,
          });
          return ok(JSON.stringify({ record: completed }, null, 2));
        }
        if (gateNeedsWeb(gate) && await hasWebLock(snapshot.lease.worktree) && !await webDependenciesReady(snapshot.lease.worktree)) {
          if (!args.bootstrap_web) {
            const completed = await finishFencedRecord(dependencies, record, authority, {
              state: "preflight_failed",
              durationMs: dependencies.now().getTime() - startedAt.getTime(),
              failure: "web dependencies are absent; repeat with bootstrap_web=true to run the fixed npm ci bootstrap",
            });
            return ok(JSON.stringify({ record: completed }, null, 2));
          }
          const bootstrap = await dependencies.command(
            "mise",
            ["exec", "node@22.22.2", "--", "npm", "--prefix", "web", "ci", "--ignore-scripts"],
            {
              cwd: snapshot.lease.worktree,
              gitCommonDir: snapshot.lease.gitCommonDir,
              stateDir: dependencies.stateDir,
              allowNetwork: true,
              timeoutMs: boundedCommandTimeout(controller.expiresAt, dependencies.now(), 900_000),
              environment: commandEnvironment(dependencies.stateDir, true),
              runId,
            },
          );
          if (bootstrap.timedOut || bootstrap.exitCode !== 0) {
            const completed = await finishFencedRecord(dependencies, record, authority, {
              state: bootstrap.timedOut ? "timed_out" : "preflight_failed",
              durationMs: dependencies.now().getTime() - startedAt.getTime(),
              exitCode: bootstrap.exitCode,
              command: bootstrap.argv,
              stdoutSha256: bootstrap.stdoutSha256,
              stderrSha256: bootstrap.stderrSha256,
              failure: "web dependency bootstrap failed",
            });
            return ok(JSON.stringify({ record: completed, stdoutTail: bootstrap.stdoutTail, stderrTail: bootstrap.stderrTail }, null, 2));
          }
        }
        for (const lockPath of pythonLocks) {
          const manifest = await materializeBaseRequirementsLock(
            dependencies.git,
            snapshot.lease.worktree,
            snapshot.lease.baseCommit,
            lockPath,
            dependencies.stateDir,
            runId,
          );
          const bootstrap = await dependencies.command(
            "uv",
            [
              "pip", "install", "--require-hashes", "--no-build", "--no-config",
              "--target", `/gate-home/python-bootstrap/${createHash("sha256").update(lockPath).digest("hex")}`,
              "--requirements", manifest.destination,
            ],
            {
              cwd: snapshot.lease.worktree,
              gitCommonDir: snapshot.lease.gitCommonDir,
              stateDir: dependencies.stateDir,
              allowNetwork: true,
              timeoutMs: boundedCommandTimeout(controller.expiresAt, dependencies.now(), 900_000),
              environment: commandEnvironment(dependencies.stateDir, true),
              runId,
              readOnlyFiles: [manifest],
            },
          );
          if (bootstrap.timedOut || bootstrap.exitCode !== 0) {
            const completed = await finishFencedRecord(dependencies, record, authority, {
              state: bootstrap.timedOut ? "timed_out" : "preflight_failed",
              durationMs: dependencies.now().getTime() - startedAt.getTime(),
              exitCode: bootstrap.exitCode,
              command: bootstrap.argv,
              stdoutSha256: bootstrap.stdoutSha256,
              stderrSha256: bootstrap.stderrSha256,
              failure: `Python dependency bootstrap failed for ${lockPath}`,
            });
            return ok(JSON.stringify({ record: completed, stdoutTail: bootstrap.stdoutTail, stderrTail: bootstrap.stderrTail }, null, 2));
          }
        }
        const beforeGate = await inspectWorker(
          dependencies,
          snapshot.lease.controllerId,
          snapshot.lease.leaseId,
          snapshot.lease.baseCommit,
          snapshot.headCommit,
          snapshot.gitStatusSha256,
        );
        if (beforeGate.worktreeSha256 !== snapshot.worktreeSha256) {
          const completed = await finishFencedRecord(dependencies, record, authority, {
            state: "invalidated",
            durationMs: dependencies.now().getTime() - startedAt.getTime(),
            afterWorktreeSha256: beforeGate.worktreeSha256,
            failure: "writer content changed during verification preflight",
          });
          return ok(JSON.stringify({ record: completed }, null, 2));
        }
        phase = "gate";
        const verification = await dependencies.command(
          "uv",
          ["run", "just", gate],
          {
            cwd: snapshot.lease.worktree,
            gitCommonDir: snapshot.lease.gitCommonDir,
            stateDir: dependencies.stateDir,
            allowNetwork: false,
            timeoutMs: boundedCommandTimeout(
              controller.expiresAt,
              dependencies.now(),
              ((args.timeout_seconds as number) ?? 1800) * 1000,
            ),
            environment: commandEnvironment(dependencies.stateDir, false),
            runId,
          },
        );
        phase = "postgate";
        const after = await inspectWorker(
          dependencies,
          snapshot.lease.controllerId,
          snapshot.lease.leaseId,
          snapshot.lease.baseCommit,
          snapshot.headCommit,
          snapshot.gitStatusSha256,
        );
        const unchanged = after.worktreeSha256 === snapshot.worktreeSha256;
        const completed = await finishFencedRecord(dependencies, record, authority, {
          state: unchanged ? resultState(verification) : "invalidated",
          durationMs: dependencies.now().getTime() - startedAt.getTime(),
          exitCode: verification.exitCode,
          command: verification.argv,
          stdoutSha256: verification.stdoutSha256,
          stderrSha256: verification.stderrSha256,
          afterWorktreeSha256: after.worktreeSha256,
          failure: unchanged ? undefined : "writer content changed while the gate was running",
        });
        return ok(JSON.stringify({
          record: completed,
          stdoutTail: verification.stdoutTail,
          stderrTail: verification.stderrTail,
        }, null, 2));
        } catch (error) {
          const completed = await finishFencedRecord(dependencies, record, authority, {
            state: phase === "preflight" ? "preflight_failed" : "invalidated",
            durationMs: dependencies.now().getTime() - startedAt.getTime(),
            failure: error instanceof Error ? error.message : String(error),
          });
          return ok(JSON.stringify({ record: completed }, null, 2));
        } finally {
          await rm(join(dependencies.stateDir, "gate-sandbox-homes", runId), { recursive: true, force: true });
          await rm(join(dependencies.stateDir, "gate-inputs", runId), { recursive: true, force: true });
        }
      },
    },
    {
      name: "herdr_owned_worker_verification_list",
      description: "List content-free host verification records, optionally for one controller or writer lease. This is read-only and never returns command output.",
      inputSchema: {
        controller_id: z.string().min(1).max(100).optional(),
        lease_id: z.string().uuid().optional(),
      },
      run: async (args) => ok(JSON.stringify({
        records: await dependencies.records.list(
          args.controller_id as string | undefined,
          args.lease_id as string | undefined,
        ),
      }, null, 2)),
    },
  ];
}

export const safeVerificationTools = createSafeVerificationTools();
