import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControllerLeaseStore,
  WriterLeaseStore,
  reservationLockStatus,
} from "../src/lease-store.js";

const stateDir = await mkdtemp(join(tmpdir(), "herdr-mesh-lock-test-"));
try {
  const writer = new WriterLeaseStore(stateDir);
  const staleWriterLock = join(writer.directory, ".reservation-lock");
  await mkdir(staleWriterLock, { recursive: true });
  await writeFile(join(staleWriterLock, "owner.json"), JSON.stringify({
    version: 1,
    lockId: "11111111-1111-4111-8111-111111111111",
    pid: 999_999_999,
    hostname: hostname(),
    acquiredAt: "2026-08-25T10:00:00.000Z",
  }));
  assert.equal((await reservationLockStatus(writer.directory)).state, "stale");

  let recovered = false;
  await writer.withExclusiveReservation(async () => { recovered = true; });
  assert.equal(recovered, true);
  assert.equal((await reservationLockStatus(writer.directory)).state, "absent");

  const controller = new ControllerLeaseStore(stateDir);
  const liveControllerLock = join(controller.directory, ".reservation-lock");
  await mkdir(liveControllerLock, { recursive: true });
  await writeFile(join(liveControllerLock, "owner.json"), JSON.stringify({
    version: 1,
    lockId: "22222222-2222-4222-8222-222222222222",
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  }));
  assert.equal((await reservationLockStatus(controller.directory)).state, "active");
  await assert.rejects(
    controller.withExclusiveReservation(async () => {}),
    /reservation is busy/,
  );

  const foreign = new WriterLeaseStore(join(stateDir, "foreign"));
  const foreignLock = join(foreign.directory, ".reservation-lock");
  await mkdir(foreignLock, { recursive: true });
  await writeFile(join(foreignLock, "owner.json"), JSON.stringify({
    version: 1,
    lockId: "33333333-3333-4333-8333-333333333333",
    pid: process.pid,
    hostname: `${hostname()}-other`,
    acquiredAt: new Date().toISOString(),
  }));
  assert.deepEqual(await reservationLockStatus(foreign.directory), {
    state: "indeterminate",
    reason: "lock owner belongs to another host identity",
  });

  const reusedPid = new WriterLeaseStore(join(stateDir, "reused-pid"));
  const reusedPidLock = join(reusedPid.directory, ".reservation-lock");
  await mkdir(reusedPidLock, { recursive: true });
  await writeFile(join(reusedPidLock, "owner.json"), JSON.stringify({
    version: 2,
    lockId: "44444444-4444-4444-8444-444444444444",
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
    bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    processStartTicks: "0",
  }));
  assert.deepEqual(await reservationLockStatus(reusedPid.directory), {
    state: "stale",
    reason: "lock owner PID now belongs to a different process",
  });

  const foreignV2 = new WriterLeaseStore(join(stateDir, "foreign-v2"));
  const foreignV2Lock = join(foreignV2.directory, ".reservation-lock");
  await mkdir(foreignV2Lock, { recursive: true });
  await writeFile(join(foreignV2Lock, "owner.json"), JSON.stringify({
    version: 2,
    lockId: "55555555-5555-4555-8555-555555555555",
    pid: process.pid,
    hostname: `${hostname()}-other`,
    acquiredAt: new Date().toISOString(),
    bootId: "foreign-boot-id",
    processStartTicks: "0",
  }));
  assert.deepEqual(await reservationLockStatus(foreignV2.directory), {
    state: "indeterminate",
    reason: "lock owner belongs to another host identity",
  });
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("lease store crash-recovery contract passed");
