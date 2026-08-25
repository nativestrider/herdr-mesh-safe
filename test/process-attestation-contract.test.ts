import assert from "node:assert/strict";
import { processDescendsFrom, type ProcessIdentity } from "../src/process-attestation.js";

const expected: ProcessIdentity = { pid: 40, bootId: "boot-a", startTicks: "400" };
const snapshots = new Map([
  [50, { pid: 50, parentPid: 45, bootId: "boot-a", startTicks: "500" }],
  [45, { pid: 45, parentPid: 40, bootId: "boot-a", startTicks: "450" }],
  [40, { pid: 40, parentPid: 1, bootId: "boot-a", startTicks: "400" }],
  [60, { pid: 60, parentPid: 1, bootId: "boot-a", startTicks: "600" }],
  [1, { pid: 1, parentPid: 0, bootId: "boot-a", startTicks: "1" }],
]);
const read = async (pid: number) => {
  const snapshot = snapshots.get(pid);
  if (!snapshot) throw new Error(`missing fixture process ${pid}`);
  return snapshot;
};

assert.equal(await processDescendsFrom(50, expected, read), true);
assert.equal(await processDescendsFrom(60, expected, read), false);
assert.equal(await processDescendsFrom(50, { ...expected, startTicks: "reused" }, read), false);
assert.equal(await processDescendsFrom(50, { ...expected, bootId: "previous-boot" }, read), false);

console.log("controller process attestation contract passed");
