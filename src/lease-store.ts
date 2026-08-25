import { mkdir, readFile, readdir, rename, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const lockDirectory = join(this.directory, ".reservation-lock");
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new Error("writer lease reservation is busy; retry after the active reservation completes");
      throw error;
    }
    try {
      return await operation();
    } finally {
      await rmdir(lockDirectory);
    }
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
