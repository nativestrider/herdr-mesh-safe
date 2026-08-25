import { mkdir, readFile, readdir, rename, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
        const lockDirectory = join(this.directory, ".reservation-lock");
        try {
            await mkdir(lockDirectory, { mode: 0o700 });
        }
        catch (error) {
            const code = error.code;
            if (code === "EEXIST")
                throw new Error("writer lease reservation is busy; retry after the active reservation completes");
            throw error;
        }
        try {
            return await operation();
        }
        finally {
            await rmdir(lockDirectory);
        }
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
//# sourceMappingURL=lease-store.js.map