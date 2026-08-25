import assert from "node:assert/strict";
import { buildNetworkResolverBindArgs } from "../src/tools/safe-verification.js";

assert.deepEqual(
  buildNetworkResolverBindArgs("/run/systemd/resolve/stub-resolv.conf"),
  [
    "--dir", "/run",
    "--dir", "/run/systemd",
    "--dir", "/run/systemd/resolve",
    "--ro-bind", "/run/systemd/resolve/stub-resolv.conf", "/run/systemd/resolve/stub-resolv.conf",
  ],
);
assert.deepEqual(buildNetworkResolverBindArgs("/etc/resolv.conf"), []);
assert.throws(() => buildNetworkResolverBindArgs("relative/resolv.conf"), /absolute/);

console.log("sandbox network resolver contract passed");
