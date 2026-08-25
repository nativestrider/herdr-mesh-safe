import assert from "node:assert/strict";
import { main, requireManagedCaller, usage } from "../src/agent-control.js";
import type { ToolDef } from "../src/tools/types.js";

const help = usage();
for (const operation of ["status", "receipts", "ask", "ask-many", "collect", "abandon"]) {
  assert.match(help, new RegExp(`herdr-agent-control ${operation}`));
}
assert.match(help, /collect --receipt TOKEN/);

assert.throws(() => requireManagedCaller({}), /Herdr-managed coordinator pane/);
const environment = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p1",
  AGENT_CONTROL_CONTROLLER_ID: "example",
};
assert.equal(requireManagedCaller(environment), "example");

let authorityCalls = 0;
let toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let output = "";
const definition = (name: string): ToolDef => ({
  name,
  description: name,
  inputSchema: {},
  run: async (args) => {
    toolCalls.push({ name, args });
    return { content: [{ type: "text", text: JSON.stringify({ name, ok: true }) }] };
  },
});
const dependencies = {
  environment,
  resolveAuthority: async () => {
    authorityCalls += 1;
    return {
      leaseId: "11111111-1111-4111-8111-111111111111",
      fenceToken: "22222222-2222-4222-8222-222222222222",
    } as never;
  },
  compositeDefinitions: [
    definition("herdr_batch_handoff"),
    definition("herdr_collect_handoffs"),
    definition("herdr_handoff_receipt_list"),
    definition("herdr_handoff_receipt_abandon"),
  ],
  paneLeaseDefinitions: [definition("herdr_lease_inventory")],
  write: (text: string) => { output += text; },
};

await main(["status"], dependencies);
assert.equal(authorityCalls, 0, "status must not recover the controller fence");
assert.equal(toolCalls.at(-1)?.name, "herdr_lease_inventory");
assert.deepEqual(toolCalls.at(-1)?.args, { controller_id: "example" });

await main(["receipts"], dependencies);
assert.equal(authorityCalls, 0, "receipt listing must not recover the controller fence");
assert.equal(toolCalls.at(-1)?.name, "herdr_handoff_receipt_list");

await main(["ask", "worker", "--timeout-ms", "5000", "--", "Review", "this"], dependencies);
assert.equal(authorityCalls, 1);
assert.equal(toolCalls.at(-1)?.name, "herdr_batch_handoff");
assert.deepEqual(toolCalls.at(-1)?.args.requests, [{ target: "worker", message: "Review this" }]);

const callCount = toolCalls.length;
await assert.rejects(
  main(["ask", "worker", "--mode", "first", "--", "No"], dependencies),
  /--mode is not supported/,
);
assert.equal(toolCalls.length, callCount, "invalid ask options must not reach the bridge");
await assert.rejects(main(["ask", "--mode", "--", "No"], dependencies), /target is missing or invalid/);
assert.equal(toolCalls.length, callCount);

await assert.rejects(
  main(["collect", "worker"], dependencies),
  /unknown collect arguments: worker/,
);
assert.equal(toolCalls.length, callCount);

const receipt = "herdr-receipt-v1.33333333-3333-4333-8333-333333333333";
await main(["collect", "--receipt", receipt, "--mode", "first"], dependencies);
assert.equal(toolCalls.at(-1)?.name, "herdr_collect_handoffs");
assert.deepEqual(toolCalls.at(-1)?.args.receipts, [receipt]);
assert.equal(toolCalls.at(-1)?.args.mode, "first");

await main(["abandon", "--receipt", receipt], dependencies);
assert.equal(toolCalls.at(-1)?.name, "herdr_handoff_receipt_abandon");
assert.equal(toolCalls.at(-1)?.args.receipt, receipt);

assert.doesNotMatch(output, /22222222-2222-4222-8222-222222222222/);
console.log("agent-control CLI behavior contract passed");
