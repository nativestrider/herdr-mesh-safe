import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
const RESERVATION_LOCK_TTL_MS = 30_000;
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
async function localProcessIdentity(pid) {
    try {
        const [bootId, processStat] = await Promise.all([
            readFile("/proc/sys/kernel/random/boot_id", "utf8"),
            readFile(`/proc/${pid}/stat`, "utf8"),
        ]);
        const commandEnd = processStat.lastIndexOf(")");
        if (commandEnd < 0)
            return {};
        const fieldsAfterCommand = processStat.slice(commandEnd + 1).trim().split(/\s+/);
        const processStartTicks = fieldsAfterCommand[19];
        if (!processStartTicks)
            return {};
        return { bootId: bootId.trim(), processStartTicks };
    }
    catch {
        return {};
    }
}
async function reservationOwnerState(owner) {
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
function validReservationLockOwner(value) {
    if (!value || typeof value !== "object")
        return false;
    const owner = value;
    return (owner.version === 1 || owner.version === 2) &&
        typeof owner.lockId === "string" &&
        Number.isSafeInteger(owner.pid) &&
        Number(owner.pid) > 0 &&
        typeof owner.hostname === "string" &&
        typeof owner.acquiredAt === "string";
}
export async function reservationLockStatus(directory) {
    const lockDirectory = join(directory, ".reservation-lock");
    try {
        const owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
        if (validReservationLockOwner(owner)) {
            return reservationOwnerState(owner);
        }
    }
    catch (error) {
        const code = error.code;
        if (code !== "ENOENT" && !(error instanceof SyntaxError))
            throw error;
    }
    try {
        const lockStat = await stat(lockDirectory);
        if (Date.now() - lockStat.mtimeMs > RESERVATION_LOCK_TTL_MS) {
            return { state: "stale", reason: "owner metadata is unavailable and the recovery threshold elapsed" };
        }
        return { state: "indeterminate", reason: "owner metadata is unavailable inside the recovery threshold" };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return { state: "absent", reason: "no reservation lock exists" };
        }
        throw error;
    }
}
async function recoverStaleReservationLock(lockDirectory) {
    let stale = false;
    let observedLockId;
    try {
        const owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
        if (validReservationLockOwner(owner)) {
            observedLockId = owner.lockId;
            stale = (await reservationOwnerState(owner)).state === "stale";
        }
    }
    catch {
        const lockStat = await stat(lockDirectory);
        stale = Date.now() - lockStat.mtimeMs > RESERVATION_LOCK_TTL_MS;
        observedLockId = `legacy-${Math.trunc(lockStat.mtimeMs)}`;
    }
    if (!stale || !observedLockId)
        return { retry: false };
    const quarantine = `${lockDirectory}.stale.${observedLockId}`;
    try {
        await rename(lockDirectory, quarantine);
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT")
            return { retry: true };
        if (code === "EEXIST")
            return { retry: false };
        throw error;
    }
    // Keep the tombstone so a delayed reclaimer cannot move a later live lock under the observed stale identity.
    return { retry: true, quarantine };
}
async function withReservationLock(directory, busyMessage, operation) {
    const lockDirectory = join(directory, ".reservation-lock");
    let acquired = false;
    let acquiredLockId;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await mkdir(lockDirectory, { mode: 0o700 });
            try {
                const identity = await localProcessIdentity(process.pid);
                const owner = {
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
            }
            catch (error) {
                await rm(lockDirectory, { recursive: true, force: true });
                throw error;
            }
            acquired = true;
            break;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            if (attempt === 0) {
                const recovered = await recoverStaleReservationLock(lockDirectory);
                if (recovered.retry) {
                    continue;
                }
            }
            throw new Error(busyMessage);
        }
    }
    if (!acquired)
        throw new Error(busyMessage);
    try {
        return await operation();
    }
    finally {
        const currentOwner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
        if (currentOwner.lockId !== acquiredLockId) {
            throw new Error("reservation lock identity changed; refusing to remove a successor lock");
        }
        await rm(lockDirectory, { recursive: true, force: true });
    }
}
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROLLER_ID = /^[A-Za-z0-9_.-]{1,100}$/;
export class LeaseStore {
    directory;
    constructor(stateDir = process.env.HERDR_MESH_STATE_DIR ?? join(homedir(), ".local", "state", "herdr-mesh")) {
        this.directory = join(stateDir, "reviewer-leases");
    }
    async create(lease) {
        this.assertLeaseId(lease.leaseId);
        await this.ensureDirectory();
        await writeFile(this.pathFor(lease.leaseId), this.serialize(lease), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
    }
    async update(lease) {
        this.assertLeaseId(lease.leaseId);
        await this.ensureDirectory();
        const destination = this.pathFor(lease.leaseId);
        await readFile(destination, "utf8");
        const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, this.serialize(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, destination);
    }
    async get(leaseId) {
        this.assertLeaseId(leaseId);
        return this.parse(await readFile(this.pathFor(leaseId), "utf8"));
    }
    async list(controllerId) {
        await this.ensureDirectory();
        const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
        const leases = [];
        for (const name of names) {
            const lease = this.parse(await readFile(join(this.directory, name), "utf8"));
            if (!controllerId || lease.controllerId === controllerId)
                leases.push(lease);
        }
        return leases;
    }
    async withExclusiveReservation(operation) {
        await this.ensureDirectory();
        return withReservationLock(this.directory, "reviewer lease reservation is busy; retry after the active reservation completes", operation);
    }
    async ensureDirectory() {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
    }
    pathFor(leaseId) {
        return join(this.directory, `${leaseId}.json`);
    }
    assertLeaseId(leaseId) {
        if (!LEASE_ID.test(leaseId))
            throw new Error("invalid reviewer lease id");
    }
    serialize(lease) {
        return `${JSON.stringify(lease, null, 2)}\n`;
    }
    parse(raw) {
        const value = JSON.parse(raw);
        if (value.version !== 1 || !LEASE_ID.test(value.leaseId)) {
            throw new Error("invalid reviewer lease record");
        }
        return value;
    }
}
export class WriterLeaseStore {
    directory;
    constructor(stateDir = process.env.HERDR_MESH_STATE_DIR ?? join(homedir(), ".local", "state", "herdr-mesh")) {
        this.directory = join(stateDir, "writer-leases");
    }
    async create(lease) {
        this.assertLeaseId(lease.leaseId);
        await this.ensureDirectory();
        await writeFile(this.pathFor(lease.leaseId), this.serialize(lease), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
    }
    async update(lease) {
        this.assertLeaseId(lease.leaseId);
        await this.ensureDirectory();
        const destination = this.pathFor(lease.leaseId);
        await readFile(destination, "utf8");
        const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, this.serialize(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, destination);
    }
    async get(leaseId) {
        this.assertLeaseId(leaseId);
        return this.parse(await readFile(this.pathFor(leaseId), "utf8"));
    }
    async list(controllerId) {
        await this.ensureDirectory();
        const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
        const leases = [];
        for (const name of names) {
            const lease = this.parse(await readFile(join(this.directory, name), "utf8"));
            if (!controllerId || lease.controllerId === controllerId)
                leases.push(lease);
        }
        return leases;
    }
    async withExclusiveReservation(operation) {
        await this.ensureDirectory();
        return withReservationLock(this.directory, "writer lease reservation is busy; retry after the active reservation completes", operation);
    }
    async ensureDirectory() {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
    }
    pathFor(leaseId) {
        return join(this.directory, `${leaseId}.json`);
    }
    assertLeaseId(leaseId) {
        if (!LEASE_ID.test(leaseId))
            throw new Error("invalid writer lease id");
    }
    serialize(lease) {
        return `${JSON.stringify(lease, null, 2)}\n`;
    }
    parse(raw) {
        const value = JSON.parse(raw);
        if (value.version !== 1 || value.leaseType !== "writer" || !LEASE_ID.test(value.leaseId)) {
            throw new Error("invalid writer lease record");
        }
        return value;
    }
}
export class AdoptedPaneLeaseStore {
    directory;
    constructor(stateDir = process.env.HERDR_MESH_STATE_DIR ?? join(homedir(), ".local", "state", "herdr-mesh")) {
        this.directory = join(stateDir, "adopted-pane-leases");
    }
    async create(lease) {
        this.assertLeaseId(lease.leaseId);
        await this.ensureDirectory();
        await writeFile(this.pathFor(lease.leaseId), this.serialize(lease), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
    }
    async update(lease) {
        this.assertLeaseId(lease.leaseId);
        await this.ensureDirectory();
        const destination = this.pathFor(lease.leaseId);
        await readFile(destination, "utf8");
        const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, this.serialize(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, destination);
    }
    async get(leaseId) {
        this.assertLeaseId(leaseId);
        return this.parse(await readFile(this.pathFor(leaseId), "utf8"));
    }
    async list(controllerId) {
        await this.ensureDirectory();
        const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
        const leases = [];
        for (const name of names) {
            const lease = this.parse(await readFile(join(this.directory, name), "utf8"));
            if (!controllerId || lease.controllerId === controllerId)
                leases.push(lease);
        }
        return leases;
    }
    async withExclusiveReservation(operation) {
        await this.ensureDirectory();
        return withReservationLock(this.directory, "adopted pane lease reservation is busy; retry after the active reservation completes", operation);
    }
    async ensureDirectory() {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
    }
    pathFor(leaseId) {
        return join(this.directory, `${leaseId}.json`);
    }
    assertLeaseId(leaseId) {
        if (!LEASE_ID.test(leaseId))
            throw new Error("invalid adopted pane lease id");
    }
    serialize(lease) {
        return `${JSON.stringify(lease, null, 2)}\n`;
    }
    parse(raw) {
        const value = JSON.parse(raw);
        if (value.version !== 1 || value.leaseType !== "adopted-pane" || !LEASE_ID.test(value.leaseId)) {
            throw new Error("invalid adopted pane lease record");
        }
        return value;
    }
}
export class ControllerLeaseStore {
    directory;
    constructor(stateDir = process.env.HERDR_MESH_STATE_DIR ?? join(homedir(), ".local", "state", "herdr-mesh")) {
        this.directory = join(stateDir, "controller-leases");
    }
    async get(controllerId) {
        this.assertControllerId(controllerId);
        return this.parse(await readFile(this.pathFor(controllerId), "utf8"));
    }
    async getOptional(controllerId) {
        try {
            return await this.get(controllerId);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
    }
    async list() {
        await this.ensureDirectory();
        const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
        return Promise.all(names.map(async (name) => this.parse(await readFile(join(this.directory, name), "utf8"))));
    }
    async create(lease) {
        this.assertRecord(lease);
        await this.withExclusiveReservation(async () => {
            const existing = await this.getOptional(lease.controllerId);
            if (existing?.state === "active") {
                throw new Error("controller already has a retained lease; resume or take it over instead");
            }
            await this.write(lease, existing === undefined);
        });
    }
    async replace(lease, expectedCurrentLeaseId) {
        this.assertRecord(lease);
        await this.withExclusiveReservation(async () => {
            const current = await this.get(lease.controllerId);
            if (current.leaseId !== expectedCurrentLeaseId) {
                throw new Error("controller generation changed during the operation; retry from current state");
            }
            await this.write(lease, false);
        });
    }
    async assertActive(controllerId, leaseId, fenceToken, now) {
        const lease = await this.get(controllerId);
        if (lease.state !== "active")
            throw new Error("controller lease is not active");
        if (lease.leaseId !== leaseId || lease.fenceToken !== fenceToken) {
            throw new Error("controller lease credentials do not match the active generation");
        }
        if (Date.parse(lease.expiresAt) <= now.getTime()) {
            throw new Error("controller lease has expired; resume it from the same pane or perform a fenced takeover");
        }
        return lease;
    }
    async withExclusiveReservation(operation) {
        await this.ensureDirectory();
        return withReservationLock(this.directory, "controller lease reservation is busy; retry after it completes", operation);
    }
    async ensureDirectory() {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
    }
    pathFor(controllerId) {
        this.assertControllerId(controllerId);
        return join(this.directory, `${controllerId}.json`);
    }
    async write(lease, create) {
        const destination = this.pathFor(lease.controllerId);
        if (create) {
            await writeFile(destination, this.serialize(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
            return;
        }
        const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, this.serialize(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, destination);
    }
    assertControllerId(controllerId) {
        if (!CONTROLLER_ID.test(controllerId))
            throw new Error("invalid controller id");
    }
    assertRecord(lease) {
        this.assertControllerId(lease.controllerId);
        if (!LEASE_ID.test(lease.leaseId) || !LEASE_ID.test(lease.fenceToken)) {
            throw new Error("invalid controller lease credentials");
        }
        if (lease.version !== 1 || lease.leaseType !== "controller" || lease.generation < 1) {
            throw new Error("invalid controller lease record");
        }
    }
    serialize(lease) {
        return `${JSON.stringify(lease, null, 2)}\n`;
    }
    parse(raw) {
        const value = JSON.parse(raw);
        this.assertRecord(value);
        return value;
    }
}
//# sourceMappingURL=lease-store.js.map