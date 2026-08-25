import { z } from "zod";
import { runHerdr } from "../herdr.js";
import { AdoptedPaneLeaseStore, LeaseStore, WriterLeaseStore } from "../lease-store.js";
import { assertControllerAuthority, controllerCredentials, defaultControllerAuthorityDependencies, } from "./safe-controller.js";
import { buildSettledWaitArgs, extractAgentSnapshot } from "./safe-agent.js";
import { ok, formatResult, targetSchema } from "./types.js";
export function buildRelayArgs(target, text) {
    return ["agent", "prompt", target, text, "--wait", "--until", "working", "--timeout", "5000"];
}
export function buildHandoffPromptArgs(target, message, status, timeout) {
    const argv = ["agent", "prompt", target, message, "--wait"];
    if (status && status !== "idle")
        argv.push("--until", status);
    argv.push("--timeout", String(timeout));
    return argv;
}
const terminalPromptLeaseStates = new Set(["closed", "released", "failed_closed"]);
const defaultDependencies = {
    run: runHerdr,
    controller: defaultControllerAuthorityDependencies,
    leaseStores: [new LeaseStore(), new WriterLeaseStore(), new AdoptedPaneLeaseStore()],
};
async function submitWithLeaseGuard(dependencies, controllerId, target, submit) {
    for (const store of dependencies.leaseStores ?? []) {
        let matched = false;
        let submitted;
        await store.withExclusiveReservation(async () => {
            const matches = (await store.list()).filter((lease) => lease.agentName === target && !terminalPromptLeaseStates.has(lease.state));
            if (matches.length > 1)
                throw new Error(`agent ${target} has multiple retained leases; reconcile them first`);
            if (matches.length === 0)
                return;
            const lease = matches[0];
            if (lease.controllerId !== controllerId)
                throw new Error(`agent ${target} belongs to a different controller`);
            if (lease.state !== "active") {
                throw new Error(`agent ${target} lease is ${lease.state}; refusing a new prompt during lifecycle transition`);
            }
            matched = true;
            submitted = await submit();
        });
        if (matched)
            return submitted;
    }
    return submit();
}
async function withLeaseStoreReservations(stores, operation, index = 0) {
    if (index >= stores.length)
        return operation();
    return stores[index].withExclusiveReservation(() => withLeaseStoreReservations(stores, operation, index + 1));
}
async function withBatchLeaseGuard(dependencies, controllerId, targets, operation) {
    const stores = dependencies.leaseStores ?? [];
    const inventories = await Promise.all(stores.map((store) => store.list()));
    const selected = targets.map((target) => {
        const matches = inventories.flatMap((leases, storeIndex) => leases
            .filter((lease) => lease.agentName === target && !terminalPromptLeaseStates.has(lease.state))
            .map((lease) => ({ lease, storeIndex })));
        if (matches.length > 1) {
            throw new Error(`agent ${target} has multiple retained leases; reconcile them first`);
        }
        if (matches.length === 0) {
            throw new Error(`agent ${target} has no retained lease; use herdr_handoff for an unleased agent`);
        }
        const selectedMatch = matches[0];
        const { lease } = selectedMatch;
        if (!lease.leaseId || !lease.paneId) {
            throw new Error(`agent ${target} lease lacks an exact identity; reconcile it first`);
        }
        if (lease.controllerId !== controllerId) {
            throw new Error(`agent ${target} belongs to a different controller`);
        }
        if (lease.state !== "active") {
            throw new Error(`agent ${target} lease is ${lease.state}; refusing a new prompt during lifecycle transition`);
        }
        return { target, storeIndex: selectedMatch.storeIndex, leaseId: lease.leaseId, paneId: lease.paneId };
    });
    const applicableStoreIndexes = [...new Set(selected.map((target) => target.storeIndex))];
    const applicableStores = applicableStoreIndexes.map((index) => stores[index]);
    return withLeaseStoreReservations(applicableStores, async () => {
        const lockedInventories = await Promise.all(applicableStores.map((store) => store.list()));
        for (const selection of selected) {
            const applicableIndex = applicableStoreIndexes.indexOf(selection.storeIndex);
            const lease = lockedInventories[applicableIndex].find((candidate) => candidate.leaseId === selection.leaseId);
            if (!lease || lease.agentName !== selection.target || lease.paneId !== selection.paneId ||
                lease.controllerId !== controllerId || lease.state !== "active") {
                throw new Error(`agent ${selection.target} lease identity or state changed during batch admission`);
            }
        }
        return operation(new Map(selected.map((selection) => [selection.target, selection.paneId])));
    });
}
async function waitForBatchTarget(run, cliTarget, timeout, signal) {
    await run(buildSettledWaitArgs(cliTarget, timeout), { timeoutMs: timeout + 2_000, signal });
}
async function readBatchResult(run, target, cliTarget, lines) {
    const snapshotResult = await run(["agent", "get", cliTarget], { timeoutMs: 30_000 });
    const snapshot = { ...extractAgentSnapshot(snapshotResult.json), target };
    const read = await run(["agent", "read", cliTarget, "--source", "visible", "--lines", String(lines), "--format", "text"], { timeoutMs: 30_000 });
    return {
        target,
        status: snapshot.status,
        stateChangeSeq: snapshot.stateChangeSeq,
        output: read.stdout.trim(),
    };
}
async function collectBatchResult(run, target, cliTarget, timeout, lines) {
    await waitForBatchTarget(run, cliTarget, timeout);
    return readBatchResult(run, target, cliTarget, lines);
}
export function createCompositeTools(dependencies = defaultDependencies) {
    return [
        {
            name: "herdr_relay",
            description: "Deliver and submit a prompt to an agent with the current Herdr agent prompt command.",
            inputSchema: {
                ...controllerCredentials,
                target: targetSchema,
                text: z.string().describe("Message/prompt to deliver to the agent."),
                submit: z
                    .boolean()
                    .optional()
                    .describe("Must remain true; the current bridge supports submitted prompts only."),
            },
            run: async (a) => {
                await assertControllerAuthority(dependencies.controller, String(a.controller_id), String(a.controller_lease_id), String(a.controller_fence_token));
                const target = String(a.target);
                if (a.submit === false) {
                    throw new Error("herdr_relay requires submit=true with the installed Herdr CLI");
                }
                await submitWithLeaseGuard(dependencies, String(a.controller_id), target, async () => {
                    await assertControllerAuthority(dependencies.controller, String(a.controller_id), String(a.controller_lease_id), String(a.controller_fence_token));
                    return dependencies.run(buildRelayArgs(target, String(a.text)), { timeoutMs: 10_000 });
                });
                return ok(`Delivered to "${target}" and submitted.`);
            },
        },
        {
            name: "herdr_handoff",
            description: "Hand a task to another agent and wait for its result in one step: deliver the message (with Enter), wait until the agent reaches a status (default idle), then read its output back. Use this for review/fix/verify handoffs so the multi-step chain can't break midway. Returns the target agent's resulting output.",
            inputSchema: {
                ...controllerCredentials,
                target: targetSchema,
                message: z.string().describe("Task/prompt to hand to the agent."),
                wait_status: z
                    .enum(["idle", "working", "blocked", "done", "unknown"])
                    .optional()
                    .describe("Status to wait for before reading back (default: idle)."),
                timeout_ms: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Max time to wait for the status (default 120000)."),
                read_lines: z
                    .number()
                    .int()
                    .positive()
                    .max(2000)
                    .optional()
                    .describe("Lines of output to read back (default 200)."),
            },
            timeoutMs: 180_000,
            run: async (a) => {
                await assertControllerAuthority(dependencies.controller, String(a.controller_id), String(a.controller_lease_id), String(a.controller_fence_token));
                const target = String(a.target);
                const status = a.wait_status ?? "idle";
                const timeout = a.timeout_ms ?? 120_000;
                const lines = a.read_lines ?? 200;
                await submitWithLeaseGuard(dependencies, String(a.controller_id), target, async () => {
                    await assertControllerAuthority(dependencies.controller, String(a.controller_id), String(a.controller_lease_id), String(a.controller_fence_token));
                    return dependencies.run(buildHandoffPromptArgs(target, String(a.message), status, timeout), { timeoutMs: timeout + 10_000 });
                });
                const read = await dependencies.run([
                    "agent",
                    "read",
                    target,
                    "--source",
                    "visible",
                    "--lines",
                    String(lines),
                    "--format",
                    "text",
                ]);
                return ok(`# Handoff to "${target}" — reached ${status}\n\n${formatResult(read)}`);
            },
        },
        {
            name: "herdr_batch_handoff",
            description: "Deliver up to eight independent tasks concurrently to active leased agents, then collect every settled result or the first one. Targets are resolved to exact leased panes; no losing worker is stopped or closed.",
            inputSchema: {
                ...controllerCredentials,
                requests: z
                    .array(z.object({
                    target: targetSchema,
                    message: z.string().min(1).describe("Task/prompt to hand to this agent."),
                }))
                    .min(1)
                    .max(8)
                    .refine((requests) => new Set(requests.map((request) => request.target)).size === requests.length, "batch targets must be unique"),
                mode: z.enum(["all", "first"]).optional().describe("Collect all results (default) or return after the first settles."),
                timeout_ms: z.number().int().positive().max(600_000).optional().describe("Maximum wait per target (default 120000)."),
                read_lines: z.number().int().positive().max(2000).optional().describe("Visible output lines per completed target (default 200)."),
            },
            timeoutMs: 620_000,
            run: async (a) => {
                const controllerId = String(a.controller_id);
                const requests = a.requests.map((request) => ({
                    target: String(request.target),
                    message: String(request.message),
                }));
                if (new Set(requests.map((request) => request.target)).size !== requests.length) {
                    throw new Error("batch targets must be unique");
                }
                const mode = a.mode ?? "all";
                const timeout = a.timeout_ms ?? 120_000;
                const lines = a.read_lines ?? 200;
                await assertControllerAuthority(dependencies.controller, controllerId, String(a.controller_lease_id), String(a.controller_fence_token));
                return withBatchLeaseGuard(dependencies, controllerId, requests.map((request) => request.target), async (resolvedTargets) => {
                    await assertControllerAuthority(dependencies.controller, controllerId, String(a.controller_lease_id), String(a.controller_fence_token));
                    const deliveries = await Promise.allSettled(requests.map((request) => dependencies.run(buildRelayArgs(String(resolvedTargets.get(request.target)), request.message), { timeoutMs: 10_000 })));
                    const failed = deliveries.flatMap((delivery, index) => delivery.status === "rejected"
                        ? [{ target: requests[index].target, error: "delivery_failed" }]
                        : []);
                    if (failed.length > 0) {
                        const deliveredTargets = requests
                            .filter((_request, index) => deliveries[index].status === "fulfilled")
                            .map((request) => request.target);
                        throw new Error(`batch delivery was partial; delivered=${JSON.stringify(deliveredTargets)} failed=${JSON.stringify(failed)}`);
                    }
                    if (mode === "all") {
                        const outcomes = await Promise.allSettled(requests.map((request) => collectBatchResult(dependencies.run, request.target, String(resolvedTargets.get(request.target)), timeout, lines)));
                        const completed = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
                        const failed = outcomes.flatMap((outcome, index) => outcome.status === "rejected"
                            ? [{ target: requests[index].target, stage: "collection", error: "collection_failed" }]
                            : []);
                        return ok(JSON.stringify({
                            mode,
                            completed,
                            failed,
                            pendingTargets: failed.map((failure) => failure.target),
                        }, null, 2));
                    }
                    const controllers = requests.map(() => new AbortController());
                    try {
                        const winner = await Promise.any(requests.map(async (request, index) => {
                            await waitForBatchTarget(dependencies.run, String(resolvedTargets.get(request.target)), timeout, controllers[index].signal);
                            return index;
                        }));
                        controllers.forEach((controller) => controller.abort());
                        const result = await readBatchResult(dependencies.run, requests[winner].target, String(resolvedTargets.get(requests[winner].target)), lines);
                        return ok(JSON.stringify({
                            mode,
                            completed: [result],
                            pendingTargets: requests
                                .filter((_request, index) => index !== winner)
                                .map((request) => request.target),
                        }, null, 2));
                    }
                    catch (error) {
                        controllers.forEach((controller) => controller.abort());
                        throw error;
                    }
                });
            },
        },
    ];
}
export const compositeTools = createCompositeTools();
//# sourceMappingURL=composite.js.map