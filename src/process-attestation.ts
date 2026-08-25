import { readFile } from "node:fs/promises";

export interface ProcessIdentity {
  pid: number;
  bootId: string;
  startTicks: string;
}

interface ProcessSnapshot extends ProcessIdentity {
  parentPid: number;
}

function parseStat(pid: number, raw: string, bootId: string): ProcessSnapshot {
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd < 0) throw new Error(`process ${pid} has an invalid stat record`);
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  const startTicks = fields[19];
  if (!Number.isSafeInteger(parentPid) || parentPid < 0 || !startTicks) {
    throw new Error(`process ${pid} lacks a stable Linux identity`);
  }
  return { pid, parentPid, bootId, startTicks };
}

export async function readProcessSnapshot(pid: number): Promise<ProcessSnapshot> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("controller CLI process attestation requires Linux /proc");
  }
  const [bootId, stat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
  ]);
  return parseStat(pid, stat, bootId.trim());
}

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity> {
  const { parentPid: _parentPid, ...identity } = await readProcessSnapshot(pid);
  return identity;
}

export async function processDescendsFrom(
  callerPid: number,
  expected: ProcessIdentity,
  readSnapshot: (pid: number) => Promise<ProcessSnapshot> = readProcessSnapshot,
): Promise<boolean> {
  const visited = new Set<number>();
  let pid = callerPid;
  for (let depth = 0; depth < 256 && pid > 0 && !visited.has(pid); depth += 1) {
    visited.add(pid);
    const snapshot = await readSnapshot(pid);
    if (snapshot.pid === expected.pid) {
      return snapshot.bootId === expected.bootId && snapshot.startTicks === expected.startTicks;
    }
    pid = snapshot.parentPid;
  }
  return false;
}
