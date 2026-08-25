import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const repositoryRoot = new URL("../", import.meta.url).pathname;
const generatedRoot = await mkdtemp(join(tmpdir(), "herdr-mesh-dist-"));

async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(relative(root, path));
    }
  }
  await walk(root);
  return files.sort();
}

async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} exited ${code}: ${stderr}`));
    });
  });
}

try {
  const generatedDist = join(generatedRoot, "dist");
  await run(join(repositoryRoot, "node_modules", ".bin", "tsc"), ["--outDir", generatedDist]);
  const expectedFiles = (await filesBelow(generatedDist)).filter((path) => !path.endsWith(".map"));
  const deployedFiles = (await filesBelow(join(repositoryRoot, "dist"))).filter((path) => !path.endsWith(".map"));
  assert.deepEqual(deployedFiles, expectedFiles, "committed dist inventory differs from compiled source");
  for (const path of expectedFiles) {
    assert.deepEqual(
      await readFile(join(repositoryRoot, "dist", path)),
      await readFile(join(generatedDist, path)),
      `deployed dist is stale: ${path}`,
    );
  }
} finally {
  await rm(generatedRoot, { recursive: true, force: true });
}

const expectedTools = [
  "herdr_agent_get", "herdr_agent_list", "herdr_agent_read", "herdr_agent_wait",
  "herdr_agent_wait_any", "herdr_agent_wait_settled", "herdr_bridge_status",
  "herdr_controller_acquire", "herdr_controller_list", "herdr_controller_release",
  "herdr_controller_renew", "herdr_controller_resume", "herdr_controller_takeover",
  "herdr_batch_handoff", "herdr_handoff", "herdr_integration_status", "herdr_lease_inventory", "herdr_lease_reconcile",
  "herdr_owned_pane_adopt", "herdr_owned_pane_close", "herdr_owned_pane_list",
  "herdr_owned_reviewer_cleanup", "herdr_owned_reviewer_close", "herdr_owned_reviewer_list",
  "herdr_owned_reviewer_start", "herdr_owned_worker_list", "herdr_owned_worker_release",
  "herdr_owned_worker_start", "herdr_owned_worker_verification_list",
  "herdr_owned_worker_verification_snapshot", "herdr_owned_worker_verify", "herdr_pane_get",
  "herdr_pane_list", "herdr_pane_read", "herdr_relay", "herdr_session_list",
  "herdr_tab_get", "herdr_tab_list", "herdr_wait_output", "herdr_workspace_get",
  "herdr_workspace_list",
].sort();

const { createServer } = await import(join(repositoryRoot, "dist", "server.js"));
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: "dist-contract-test", version: "1.0.0" });
try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expectedTools);
  const status = await client.callTool({ name: "herdr_bridge_status", arguments: {} });
  const text = status.content.find((item) => item.type === "text");
  assert(text && text.type === "text");
  const handshake = JSON.parse(text.text);
  assert.equal(handshake.protocol, 2);
  assert.equal(handshake.profile, "safe-orchestration");
  assert.deepEqual(Object.keys(handshake.reservationLocks).sort(), [
    "adoptedPane", "controller", "reviewer", "writer",
  ]);
  for (const lock of Object.values(handshake.reservationLocks) as Array<{ state: string; reason: string }>) {
    assert(["absent", "active", "stale", "indeterminate"].includes(lock.state));
    assert(lock.reason.length > 0);
  }
  assert.deepEqual(handshake.capabilities.sort(), [
    "batch-handoff-v1",
    "controller-fencing-v1",
    "lease-reconciliation-v1",
    "owned-pane-cleanup-v1",
    "owned-reviewer-tabs-v1",
    "owned-worker-host-verification-v1",
    "owned-worker-lanes-v1",
    "python-requirements-bootstrap-v1",
  ].sort());
} finally {
  await client.close();
  await server.close();
}

console.log("deployed MCP contract passed");
