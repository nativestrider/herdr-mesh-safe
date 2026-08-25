import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

interface ReservationLockOwner {
  version: 1 | 2;
  lockId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  bootId?: string;
  processStartTicks?: string;
}

const RESERVATION_LOCK_TTL_MS = 30_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LocalProcessIdentity {
  bootId?: string;
  processStartTicks?: string;
}

async function localProcessIdentity(pid: number): Promise<LocalProcessIdentity> {
  try {
    const [bootId, processStat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const commandEnd = processStat.lastIndexOf(")");
    if (commandEnd < 0) return {};
    const fieldsAfterCommand = processStat.slice(commandEnd + 1).trim().split(/\s+/);
    const processStartTicks = fieldsAfterCommand[19];
    if (!processStartTicks) return {};
    return { bootId: bootId.trim(), processStartTicks };
  } catch {
    return {};
  }
}

async function reservationOwnerState(owner: ReservationLockOwner): Promise<ReservationLockStatus> {
  if (owner.hostname !== hostname()) {
    return { state: "indeterminate", reason: "lock owner belongs to another host identity" };
  }
  const currentIdentity = await localProcessIdentity(owner.pid);
  if (owner.version === 2 && owner.bootId && owner.processStartTicks && currentIdentity.bootId) {
    if (owner.bootId !== currentIdentity.bootId) {
      return { state: "stale", reason: "lock owner belongs to a previous host boot" };
    }
    if (owner.processStartTicks !== currentIdentity.processStartTicks) {
      return { state: "stale", reason: "lock owner PID now belongs to a different process" };
    }
    return { state: "active", reason: "lock owner boot and process identity are current" };
  }
  if (processIsAlive(owner.pid)) {
    return { state: "active", reason: "same-host lock owner process is alive without strong boot identity" };
  }
  return { state: "stale", reason: "same-host lock owner process is absent" };
}

interface RecoveredReservationLock {
  retry: boolean;
  quarantine?: string;
}

export type ReservationLockState = "absent" | "active" | "stale" | "indeterminate";

export interface ReservationLockStatus {
  state: ReservationLockState;
  reason: string;
}

function validReservationLockOwner(value: unknown): value is ReservationLockOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<ReservationLockOwner>;
  return (owner.version === 1 || owner.version === 2) &&
    typeof owner.lockId === "string" &&
    Number.isSafeInteger(owner.pid) &&
    Number(owner.pid) > 0 &&
    typeof owner.hostname === "string" &&
    typeof owner.acquiredAt === "string";
}

export async function reservationLockStatus(directory: string): Promise<ReservationLockStatus> {
  const lockDirectory = join(directory, ".reservation-lock");
  try {
    const owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8")) as unknown;
    if (validReservationLockOwner(owner)) {
      return reservationOwnerState(owner);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  try {
    const lockStat = await stat(lockDirectory);
    if (Date.now() - lockStat.mtimeMs > RESERVATION_LOCK_TTL_MS) {
      return { state: "stale", reason: "owner metadata is unavailable and the recovery threshold elapsed" };
    }
    return { state: "indeterminate", reason: "owner metadata is unavailable inside the recovery threshold" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent", reason: "no reservation lock exists" };
    }
    throw error;
  }
}

async function recoverStaleReservationLock(lockDirectory: string): Promise<RecoveredReservationLock> {
  let stale = false;
  let observedLockId: string | undefined;
  try {
    const owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8")) as unknown;
    if (validReservationLockOwner(owner)) {
      observedLockId = owner.lockId;
      stale = (await reservationOwnerState(owner)).state === "stale";
    }
  } catch {
    const lockStat = await stat(lockDirectory);
    stale = Date.now() - lockStat.mtimeMs > RESERVATION_LOCK_TTL_MS;
    observedLockId = `legacy-${Math.trunc(lockStat.mtimeMs)}`;
  }
  if (!stale || !observedLockId) return { retry: false };

  const quarantine = `${lockDirectory}.stale.${observedLockId}`;
  try {
    await rename(lockDirectory, quarantine);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { retry: true };
    if (code === "EEXIST") return { retry: false };
    throw error;
  }
  // Keep the tombstone so a delayed reclaimer cannot move a later live lock under the observed stale identity.
  return { retry: true, quarantine };
}

async function withReservationLock<T>(
  directory: string,
  busyMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockDirectory = join(directory, ".reservation-lock");
  let acquired = false;
  let acquiredLockId: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      try {
        const identity = await localProcessIdentity(process.pid);
        const owner: ReservationLockOwner = {
          version: identity.bootId && identity.processStartTicks ? 2 : 1,
          lockId: randomUUID(),
          pid: process.pid,
          hostname: hostname(),
          acquiredAt: new Date().toISOString(),
          ...identity,
        };
        await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        acquiredLockId = owner.lockId;
      } catch (error) {
        await rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0) {
        const recovered = await recoverStaleReservationLock(lockDirectory);
        if (recovered.retry) {
          continue;
        }
      }
      throw new Error(busyMessage);
    }
  }
  if (!acquired) throw new Error(busyMessage);
  try {
    return await operation();
  } finally {
    const currentOwner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8")) as ReservationLockOwner;
    if (currentOwner.lockId !== acquiredLockId) {
      throw new Error("reservation lock identity changed; refusing to remove a successor lock");
    }
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

export type ReviewerLeaseState =
  | "provisioning"
  | "active"
  | "closing"
  | "closed"
  | "failed_closed"
  | "orphaned"
  | "close_failed";

export interface ReviewerLease {
  version: 1;
  leaseId: string;
  controllerId: string;
  purpose: string;
  parentPaneId: string;
  paneId: string;
  agentName: string;
  agentKind: string;
  cwd: string;
  state: ReviewerLeaseState;
  createdAt: string;
  closedAt?: string;
  captureSha256?: string;
  failure?: string;
}

export type WriterLeaseState =
  | "provisioning"
  | "active"
  | "releasing"
  | "released"
  | "failed_closed"
  | "orphaned"
  | "release_failed";

export interface WriterLease {
  version: 1;
  leaseType: "writer";
  leaseId: string;
  controllerId: string;
  purpose: string;
  ticketRef: string;
  authorityRef: string;
  authoritySha256: string;
  parentPaneId: string;
  paneId: string;
  agentName: string;
  agentKind: string;
  repositoryRoot: string;
  gitDir: string;
  gitCommonDir: string;
  worktree: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  gitStatusSha256: string;
  ownedScopes: string[];
  lockedScopes: string[];
  protectedBranches: string[];
  state: WriterLeaseState;
  createdAt: string;
  releasedAt?: string;
  checkpointRef?: string;
  checkpointSha256?: string;
  captureSha256?: string;
  failure?: string;
}

export type AdoptedPaneLeaseState = "active" | "closing" | "closed" | "close_failed";

export interface AdoptedPaneLease {
  version: 1;
  leaseType: "adopted-pane";
  leaseId: string;
  controllerId: string;
  purpose: string;
  authorityRef: string;
  authoritySha256: string;
  paneId: string;
  agentName: string;
  agentKind: string;
  cwd: string;
  stateChangeSeq: number;
  state: AdoptedPaneLeaseState;
  adoptedAt: string;
  closedAt?: string;
  checkpointRef?: string;
  checkpointSha256?: string;
  captureSha256?: string;
  failure?: string;
}

export type ControllerLeaseState = "active" | "released";

export interface ControllerLease {
  version: 1;
  leaseType: "controller";
  leaseId: string;
  controllerId: string;
  fenceToken: string;
  generation: number;
  authorityRef: string;
  authoritySha256: string;
  paneId: string;
  agentName: string;
  agentKind: string;
  cwd: string;
  state: ControllerLeaseState;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  releasedAt?: string;
  predecessorLeaseId?: string;
}

const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROLLER_ID = /^[A-Za-z0-9_.-]{1,100}$/;

export class LeaseStore {
  readonly directory: string;

  constructor(stateDir = process.env.HERDR_MESH_STATE_DIR ?? join(homedir(), ".local", "state", "herdr-mesh")) {
    this.directory = join(stateDir, "reviewer-leases");
  }

  async create(lease: ReviewerLease): Promise<void> {
    this.assertLeaseId(lease.leaseId);
    await this.ensureDirectory();
    await writeFile(this.pathFor(lease.leaseId), this.serialize(lease), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }

  async update(lease: ReviewerLease): Promise<void> {
    this.assertLeaseId(lease.leaseId);
    await this.ensureDirectory();
    const destination = this.pathFor(lease.leaseId);
    await readFile(destination, "utf8");
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, this.serialize(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  }

  async get(leaseId: string): Promise<ReviewerLease> {
    this.assertLeaseId(leaseId);
    return this.parse(await readFile(this.pathFor(leaseId), "utf8"));
  }

  async list(controllerId?: string): Promise<ReviewerLease[]> {
    await this.ensureDirectory();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    const leases: ReviewerLease[] = [];
    for (const name of names) {
      const lease = this.parse(await readFile(join(this.directory, name), "utf8"));
      if (!controllerId || lease.controllerId === controllerId) leases.push(lease);
    }
    return leases;
  }

  async withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    return withReservationLock(
      this.directory,
      "reviewer lease reservation is busy; retry after the active reservation completes",
      operation,
    );
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private pathFor(leaseId: string): string {
    return join(this.directory, `${leaseId}.json`);
  }

  private assertLeaseId(leaseId: string): void {
    if (!LEASE_ID.test(leaseId)) throw new Error("invalid reviewer lease id");
  }

  private serialize(lease: ReviewerLease): string {
    return `${JSON.stringify(lease, null, 2)}\n`;
  }

  private parse(raw: string): ReviewerLease {
    const value = JSON.parse(raw) as ReviewerLease;
    if (value.version !== 1 || !LEASE_ID.test(value.leaseId)) {
      throw new Error("invalid reviewer lease record");
    }
    return value;
  }
}

export class WriterLeaseStore {
  readonly directory: string;

  constructor(stateDir = process.env.HERDR_MESH_STATE_DIR ?? join(homedir(), ".local", "state", "herdr-mesh")) {
    this.directory = join(stateDir, "writer-leases");
  }

  async create(lease: WriterLease): Promise<void> {
    this.assertLeaseId(lease.leaseId);
    await this.ensureDirectory();
    await writeFile(this.pathFor(lease.leaseId), this.serialize(lease), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }

  async update(lease: WriterLease): Promise<void> {
    this.assertLeaseId(lease.leaseId);
    await this.ensureDirectory();
    const destination = this.pathFor(lease.leaseId);
    await readFile(destination, "utf8");
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, this.serialize(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  }

  async get(leaseId: string): Promise<WriterLease> {
    this.assertLeaseId(leaseId);
    return this.parse(await readFile(this.pathFor(leaseId), "utf8"));
  }

  async list(controllerId?: string): Promise<WriterLease[]> {
    await this.ensureDirectory();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    const leases: WriterLease[] = [];
    for (const name of names) {
      const lease = this.parse(await readFile(join(this.directory, name), "utf8"));
      if (!controllerId || lease.controllerId === controllerId) leases.push(lease);
    }
    return leases;
  }

  async withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    return withReservationLock(
      this.directory,
      "writer lease reservation is busy; retry after the active reservation completes",
      operation,
    );
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private pathFor(leaseId: string): string {
    return join(this.directory, `${leaseId}.json`);
  }

  private assertLeaseId(leaseId: string): void {
    if (!LEASE_ID.test(leaseId)) throw new Error("invalid writer lease id");
  }

  private serialize(lease: WriterLease): string {
    return `${JSON.stringify(lease, null, 2)}\n`;
  }

  private parse(raw: string): WriterLease {
    const value = JSON.parse(raw) as WriterLease;
    if (value.version !== 1 || value.leaseType !== "writer" || !LEASE_ID.test(value.leaseId)) {
      throw new Error("invalid writer lease record");
    }
    return value;
  }
}

export class AdoptedPaneLeaseStore {
  readonly directory: string;

  constructor(stateDir = process.env.HERDR_MESH_STATE_DIR ?? join(homedir(), ".local", "state", "herdr-mesh")) {
    this.directory = join(stateDir, "adopted-pane-leases");
  }

  async create(lease: AdoptedPaneLease): Promise<void> {
    this.assertLeaseId(lease.leaseId);
    await this.ensureDirectory();
    await writeFile(this.pathFor(lease.leaseId), this.serialize(lease), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }

  async update(lease: AdoptedPaneLease): Promise<void> {
    this.assertLeaseId(lease.leaseId);
    await this.ensureDirectory();
    const destination = this.pathFor(lease.leaseId);
    await readFile(destination, "utf8");
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, this.serialize(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  }

  async get(leaseId: string): Promise<AdoptedPaneLease> {
    this.assertLeaseId(leaseId);
    return this.parse(await readFile(this.pathFor(leaseId), "utf8"));
  }

  async list(controllerId?: string): Promise<AdoptedPaneLease[]> {
    await this.ensureDirectory();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    const leases: AdoptedPaneLease[] = [];
    for (const name of names) {
      const lease = this.parse(await readFile(join(this.directory, name), "utf8"));
      if (!controllerId || lease.controllerId === controllerId) leases.push(lease);
    }
    return leases;
  }

  async withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    return withReservationLock(
      this.directory,
      "adopted pane lease reservation is busy; retry after the active reservation completes",
      operation,
    );
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private pathFor(leaseId: string): string {
    return join(this.directory, `${leaseId}.json`);
  }

  private assertLeaseId(leaseId: string): void {
    if (!LEASE_ID.test(leaseId)) throw new Error("invalid adopted pane lease id");
  }

  private serialize(lease: AdoptedPaneLease): string {
    return `${JSON.stringify(lease, null, 2)}\n`;
  }

  private parse(raw: string): AdoptedPaneLease {
    const value = JSON.parse(raw) as AdoptedPaneLease;
    if (value.version !== 1 || value.leaseType !== "adopted-pane" || !LEASE_ID.test(value.leaseId)) {
      throw new Error("invalid adopted pane lease record");
    }
    return value;
  }
}

export class ControllerLeaseStore {
  readonly directory: string;

  constructor(stateDir = process.env.HERDR_MESH_STATE_DIR ?? join(homedir(), ".local", "state", "herdr-mesh")) {
    this.directory = join(stateDir, "controller-leases");
  }

  async get(controllerId: string): Promise<ControllerLease> {
    this.assertControllerId(controllerId);
    return this.parse(await readFile(this.pathFor(controllerId), "utf8"));
  }

  async getOptional(controllerId: string): Promise<ControllerLease | undefined> {
    try {
      return await this.get(controllerId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<ControllerLease[]> {
    await this.ensureDirectory();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => this.parse(await readFile(join(this.directory, name), "utf8"))));
  }

  async create(lease: ControllerLease): Promise<void> {
    this.assertRecord(lease);
    await this.withExclusiveReservation(async () => {
      const existing = await this.getOptional(lease.controllerId);
      if (existing?.state === "active") {
        throw new Error("controller already has a retained lease; resume or take it over instead");
      }
      await this.write(lease, existing === undefined);
    });
  }

  async replace(lease: ControllerLease, expectedCurrentLeaseId: string): Promise<void> {
    this.assertRecord(lease);
    await this.withExclusiveReservation(async () => {
      const current = await this.get(lease.controllerId);
      if (current.leaseId !== expectedCurrentLeaseId) {
        throw new Error("controller generation changed during the operation; retry from current state");
      }
      await this.write(lease, false);
    });
  }

  async assertActive(
    controllerId: string,
    leaseId: string,
    fenceToken: string,
    now: Date,
  ): Promise<ControllerLease> {
    const lease = await this.get(controllerId);
    if (lease.state !== "active") throw new Error("controller lease is not active");
    if (lease.leaseId !== leaseId || lease.fenceToken !== fenceToken) {
      throw new Error("controller lease credentials do not match the active generation");
    }
    if (Date.parse(lease.expiresAt) <= now.getTime()) {
      throw new Error("controller lease has expired; resume it from the same pane or perform a fenced takeover");
    }
    return lease;
  }

  async withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    return withReservationLock(
      this.directory,
      "controller lease reservation is busy; retry after it completes",
      operation,
    );
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private pathFor(controllerId: string): string {
    this.assertControllerId(controllerId);
    return join(this.directory, `${controllerId}.json`);
  }

  private async write(lease: ControllerLease, create: boolean): Promise<void> {
    const destination = this.pathFor(lease.controllerId);
    if (create) {
      await writeFile(destination, this.serialize(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
      return;
    }
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, this.serialize(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  }

  private assertControllerId(controllerId: string): void {
    if (!CONTROLLER_ID.test(controllerId)) throw new Error("invalid controller id");
  }

  private assertRecord(lease: ControllerLease): void {
    this.assertControllerId(lease.controllerId);
    if (!LEASE_ID.test(lease.leaseId) || !LEASE_ID.test(lease.fenceToken)) {
      throw new Error("invalid controller lease credentials");
    }
    if (lease.version !== 1 || lease.leaseType !== "controller" || lease.generation < 1) {
      throw new Error("invalid controller lease record");
    }
  }

  private serialize(lease: ControllerLease): string {
    return `${JSON.stringify(lease, null, 2)}\n`;
  }

  private parse(raw: string): ControllerLease {
    const value = JSON.parse(raw) as ControllerLease;
    this.assertRecord(value);
    return value;
  }
}
