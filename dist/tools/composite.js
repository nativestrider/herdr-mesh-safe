import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { decodeHandoffReceipt, encodeHandoffReceipt } from "../handoff-receipt.js";
import { runHerdr } from "../herdr.js";
import { AdoptedPaneLeaseStore, HandoffReceiptStore, LeaseStore, WriterLeaseStore, } from "../lease-store.js";
import { assertControllerAuthority, controllerCredentials, defaultControllerAuthorityDependencies, } from "./safe-controller.js";
import { extractAgentSnapshot, waitForSettled } from "./safe-agent.js";
import { ok, targetSchema } from "./types.js";
export function buildRelayArgs(target, text) {
    return ["agent", "prompt", target, text, "--wait", "--until", "working", "--timeout", "5000"];
}
// Retained as a public argv builder for compatibility. Safe composite handoffs
// now use buildRelayArgs plus receipt-bound collection.
export function buildHandoffPromptArgs(target, message, status, timeout) {
    const argv = ["agent", "prompt", target, message, "--wait"];
    if (status && status !== "idle")
        argv.push("--until", status);
    argv.push("--timeout", String(timeout));
    return argv;
}
const terminalPromptLeaseStates = new Set(["closed", "released", "failed_closed"]);
const outstandingReceiptStates = new Set(["reserved", "pending"]);
const settledAgentStates = new Set(["idle", "done", "blocked"]);
const defaultDependencies = {
    run: runHerdr,
    controller: defaultControllerAuthorityDependencies,
    leaseStores: [new LeaseStore(), new WriterLeaseStore(), new AdoptedPaneLeaseStore()],
    receiptStore: new HandoffReceiptStore(),
    now: () => new Date(),
    uuid: randomUUID,
};
function resolvedDependencies(dependencies) {
    return {
        ...defaultDependencies,
        ...dependencies,
        leaseStores: dependencies.leaseStores ?? defaultDependencies.leaseStores,
        receiptStore: dependencies.receiptStore ?? defaultDependencies.receiptStore,
        now: dependencies.now ?? defaultDependencies.now,
        uuid: dependencies.uuid ?? defaultDependencies.uuid,
    };
}
function mutationReservations(dependencies) {
    return [dependencies.controller.store, ...dependencies.leaseStores, dependencies.receiptStore];
}
async function withReservations(stores, operation, index = 0) {
    if (index >= stores.length)
        return operation();
    return stores[index].withExclusiveReservation(() => withReservations(stores, operation, index + 1));
}
async function resolveTargets(stores, controllerId, targets) {
    const inventories = (await Promise.all(stores.map((store) => store.list()))).flat();
    const resolved = targets.map((target) => {
        const matches = inventories.filter((lease) => lease.agentName === target && !terminalPromptLeaseStates.has(lease.state));
        if (matches.length > 1)
            throw new Error(`agent ${target} has multiple retained leases; reconcile them first`);
        if (matches.length === 0)
            throw new Error(`agent ${target} has no retained lease`);
        const lease = matches[0];
        if (!lease.leaseId || !lease.paneId)
            throw new Error(`agent ${target} lease lacks an exact identity`);
        const cwd = lease.cwd ?? lease.worktree;
        if (!lease.agentKind || !cwd)
            throw new Error(`agent ${target} lease lacks kind or cwd identity`);
        if (lease.controllerId !== controllerId)
            throw new Error(`agent ${target} belongs to a different controller`);
        if (lease.state !== "active") {
            throw new Error(`agent ${target} lease is ${lease.state}; refusing a new prompt during lifecycle transition`);
        }
        return { target, leaseId: lease.leaseId, paneId: lease.paneId, agentKind: lease.agentKind, cwd };
    });
    return new Map(resolved.map((target) => [target.target, target]));
}
async function assertNoOutstandingReceipts(store, targets) {
    const blocked = (await store.list()).filter((receipt) => targets.includes(receipt.target) && outstandingReceiptStates.has(receipt.state));
    if (blocked.length > 0) {
        throw new Error(`agents have outstanding handoffs; collect their receipts first: ${blocked.map((receipt) => receipt.target).join(", ")}`);
    }
}
function receiptToken(receipt) {
    return encodeHandoffReceipt(receipt.receiptId);
}
function assertAcceptedDelivery(snapshot, resolved, beforeSeq) {
    if (snapshot.name !== resolved.target ||
        snapshot.paneId !== resolved.paneId ||
        snapshot.kind !== resolved.agentKind ||
        !snapshot.cwd || resolve(snapshot.cwd) !== resolve(resolved.cwd) ||
        snapshot.status !== "working" ||
        !Number.isSafeInteger(snapshot.stateChangeSeq) ||
        snapshot.stateChangeSeq !== beforeSeq + 1) {
        throw new Error("Herdr did not confirm the exact leased agent working cursor");
    }
}
async function preflightTargets(dependencies, resolved) {
    const snapshots = await Promise.all([...resolved.values()].map(async (target) => {
        const result = await dependencies.run(["agent", "get", target.paneId], { timeoutMs: 30_000 });
        const snapshot = { ...extractAgentSnapshot(result.json), target: target.target };
        if (snapshot.name !== target.target ||
            snapshot.paneId !== target.paneId ||
            snapshot.kind !== target.agentKind ||
            !snapshot.cwd || resolve(snapshot.cwd) !== resolve(target.cwd)) {
            throw new Error(`leased identity for ${target.target} changed before delivery`);
        }
        if (!settledAgentStates.has(snapshot.status)) {
            throw new Error(`agent ${target.target} is ${snapshot.status}; refusing to overlap a prompt`);
        }
        return snapshot;
    }));
    return new Map(snapshots.map((snapshot) => [snapshot.target, snapshot]));
}
async function reserveReceipts(dependencies, controllerId, controllerLeaseId, requests, resolved, preflight) {
    const createdAt = dependencies.now().toISOString();
    const receipts = requests.map((request) => {
        const target = resolved.get(request.target);
        const snapshot = preflight.get(request.target);
        if (!target)
            throw new Error(`target resolution disappeared for ${request.target}`);
        if (!snapshot)
            throw new Error(`target preflight disappeared for ${request.target}`);
        return {
            version: 1,
            receiptId: dependencies.uuid(),
            controllerId,
            controllerLeaseId,
            target: target.target,
            targetLeaseId: target.leaseId,
            paneId: target.paneId,
            agentKind: target.agentKind,
            cwd: target.cwd,
            state: "reserved",
            createdAt,
            updatedAt: createdAt,
            beforeSeq: snapshot.stateChangeSeq,
        };
    });
    for (const receipt of receipts)
        await dependencies.receiptStore.create(receipt);
    return receipts;
}
async function deliver(dependencies, receipt, message) {
    try {
        const result = await dependencies.run(buildRelayArgs(receipt.paneId, message), { timeoutMs: 10_000 });
        const snapshot = { ...extractAgentSnapshot(result.json), target: receipt.target };
        assertAcceptedDelivery(snapshot, {
            target: receipt.target,
            leaseId: receipt.targetLeaseId,
            paneId: receipt.paneId,
            agentKind: receipt.agentKind,
            cwd: receipt.cwd,
        }, receipt.beforeSeq);
        const pending = {
            ...receipt,
            state: "pending",
            afterSeq: snapshot.stateChangeSeq,
            updatedAt: dependencies.now().toISOString(),
        };
        await dependencies.receiptStore.update(pending);
        return pending;
    }
    catch {
        // The command may have crossed the process boundary before failing. Keep
        // the reserved record as a fail-closed admission barrier.
        return receipt;
    }
}
async function failReceipt(dependencies, receipt, failure) {
    await dependencies.receiptStore.update({
        ...receipt,
        state: "failed",
        failure,
        updatedAt: dependencies.now().toISOString(),
    });
    throw new Error(failure === "cursor_superseded"
        ? `handoff cursor for ${receipt.target} was superseded; refusing later output`
        : `leased identity for ${receipt.target} changed; refusing output`);
}
function assertReceiptSnapshot(snapshot, receipt) {
    if (snapshot.name !== receipt.target ||
        snapshot.paneId !== receipt.paneId ||
        snapshot.kind !== receipt.agentKind ||
        !snapshot.cwd || resolve(snapshot.cwd) !== resolve(receipt.cwd))
        return "identity_changed";
    if (snapshot.stateChangeSeq !== Number(receipt.afterSeq) + 1)
        return "cursor_superseded";
    return undefined;
}
async function collectOne(dependencies, receipt, timeout, lines, signal) {
    if (receipt.state === "completed") {
        const beforeReadResult = await dependencies.run(["agent", "get", receipt.paneId], {
            timeoutMs: 30_000,
            signal,
        });
        const beforeRead = { ...extractAgentSnapshot(beforeReadResult.json), target: receipt.target };
        if (beforeRead.name !== receipt.target ||
            beforeRead.paneId !== receipt.paneId ||
            beforeRead.kind !== receipt.agentKind ||
            !beforeRead.cwd || resolve(beforeRead.cwd) !== resolve(receipt.cwd) ||
            beforeRead.stateChangeSeq !== receipt.settledSeq ||
            !settledAgentStates.has(beforeRead.status)) {
            throw new Error(`completed handoff output for ${receipt.target} is no longer the current settled state`);
        }
        const read = await dependencies.run(["agent", "read", receipt.paneId, "--source", "visible", "--lines", String(lines), "--format", "text"], { timeoutMs: 30_000, signal });
        const afterReadResult = await dependencies.run(["agent", "get", receipt.paneId], {
            timeoutMs: 30_000,
            signal,
        });
        const afterRead = { ...extractAgentSnapshot(afterReadResult.json), target: receipt.target };
        if (afterRead.name !== beforeRead.name ||
            afterRead.paneId !== beforeRead.paneId ||
            afterRead.kind !== beforeRead.kind ||
            !afterRead.cwd || !beforeRead.cwd || resolve(afterRead.cwd) !== resolve(beforeRead.cwd) ||
            afterRead.status !== beforeRead.status ||
            afterRead.stateChangeSeq !== beforeRead.stateChangeSeq) {
            throw new Error(`completed handoff output for ${receipt.target} changed during capture`);
        }
        return {
            target: receipt.target,
            receipt: receiptToken(receipt),
            status: beforeRead.status,
            stateChangeSeq: beforeRead.stateChangeSeq,
            output: read.stdout.trim(),
        };
    }
    if (receipt.state !== "pending" || receipt.afterSeq === undefined) {
        throw new Error(`handoff receipt for ${receipt.target} is ${receipt.state}, not pending`);
    }
    const settled = await waitForSettled(dependencies.run, receipt.paneId, timeout, receipt.afterSeq, signal);
    const invalid = assertReceiptSnapshot(settled, receipt);
    if (invalid)
        return failReceipt(dependencies, receipt, invalid);
    const read = await dependencies.run(["agent", "read", receipt.paneId, "--source", "visible", "--lines", String(lines), "--format", "text"], { timeoutMs: 30_000, signal });
    const afterReadResult = await dependencies.run(["agent", "get", receipt.paneId], {
        timeoutMs: 30_000,
        signal,
    });
    const afterRead = { ...extractAgentSnapshot(afterReadResult.json), target: receipt.target };
    const changed = assertReceiptSnapshot(afterRead, receipt);
    if (changed || afterRead.status !== settled.status) {
        return failReceipt(dependencies, receipt, changed ?? "identity_changed");
    }
    await dependencies.receiptStore.update({
        ...receipt,
        state: "completed",
        settledSeq: settled.stateChangeSeq,
        updatedAt: dependencies.now().toISOString(),
    });
    return {
        target: receipt.target,
        receipt: receiptToken(receipt),
        status: settled.status,
        stateChangeSeq: settled.stateChangeSeq,
        output: read.stdout.trim(),
    };
}
async function collectReceipts(dependencies, receipts, mode, timeout, lines) {
    if (mode === "all") {
        const outcomes = await Promise.allSettled(receipts.map((receipt) => collectOne(dependencies, receipt, timeout, lines)));
        const completed = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
        const failed = outcomes.flatMap((outcome, index) => outcome.status === "rejected"
            ? [{ target: receipts[index].target, receipt: receiptToken(receipts[index]), stage: "collection", error: "collection_failed" }]
            : []);
        const pendingReceipts = [];
        for (const receipt of receipts) {
            const current = await dependencies.receiptStore.get(receipt.receiptId);
            if (outstandingReceiptStates.has(current.state))
                pendingReceipts.push(receiptToken(current));
        }
        return ok(JSON.stringify({ mode, completed, failed, pendingReceipts }, null, 2));
    }
    const controllers = receipts.map(() => new AbortController());
    const tasks = receipts.map((receipt, index) => collectOne(dependencies, receipt, timeout, lines, controllers[index].signal));
    try {
        let winnerIndex;
        try {
            winnerIndex = (await Promise.any(tasks.map(async (task, index) => ({ index, result: await task })))).index;
        }
        catch {
            // All attempts rejected. Their durable receipt states below distinguish
            // retryable pending work from terminal identity/cursor failures.
        }
        if (winnerIndex !== undefined) {
            controllers.forEach((controller, index) => {
                if (index !== winnerIndex)
                    controller.abort();
            });
        }
        const outcomes = await Promise.allSettled(tasks);
        const completed = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
        const pendingReceipts = [];
        const failed = [];
        for (const [index, receipt] of receipts.entries()) {
            const current = await dependencies.receiptStore.get(receipt.receiptId);
            if (outstandingReceiptStates.has(current.state))
                pendingReceipts.push(receiptToken(current));
            if (outcomes[index].status === "rejected" &&
                (current.state === "failed" || winnerIndex === undefined)) {
                failed.push({
                    target: receipt.target,
                    receipt: receiptToken(receipt),
                    stage: "collection",
                    error: "collection_failed",
                });
            }
        }
        return ok(JSON.stringify({
            mode,
            completed,
            failed,
            pendingReceipts,
        }, null, 2));
    }
    finally {
        controllers.forEach((controller) => controller.abort());
    }
}
async function executeBatch(args, suppliedDependencies) {
    const dependencies = resolvedDependencies(suppliedDependencies);
    if (args.requests.length < 1 || args.requests.length > 8) {
        throw new Error("batch handoff requires between one and eight requests");
    }
    const targets = args.requests.map((request) => request.target);
    if (new Set(targets).size !== targets.length)
        throw new Error("batch targets must be unique");
    await assertControllerAuthority(dependencies.controller, args.controllerId, args.controllerLeaseId, args.controllerFenceToken);
    return withReservations(mutationReservations(dependencies), async () => {
        const resolved = await resolveTargets(dependencies.leaseStores, args.controllerId, targets);
        await assertNoOutstandingReceipts(dependencies.receiptStore, targets);
        const preflight = await preflightTargets(dependencies, resolved);
        await assertControllerAuthority(dependencies.controller, args.controllerId, args.controllerLeaseId, args.controllerFenceToken);
        const receipts = await reserveReceipts(dependencies, args.controllerId, args.controllerLeaseId, args.requests, resolved, preflight);
        const delivered = await Promise.all(receipts.map((receipt, index) => deliver(dependencies, receipt, args.requests[index].message)));
        const pending = delivered.filter((receipt) => receipt.state === "pending");
        const ambiguous = delivered.filter((receipt) => receipt.state === "reserved");
        if (args.mode === "none" || pending.length === 0) {
            return ok(JSON.stringify({
                mode: args.mode ?? "all",
                completed: [],
                failed: ambiguous.map((receipt) => ({
                    target: receipt.target,
                    receipt: receiptToken(receipt),
                    stage: "delivery",
                    error: "delivery_ambiguous",
                })),
                pendingReceipts: pending.map(receiptToken),
            }, null, 2));
        }
        const collected = await collectReceipts(dependencies, pending, args.mode ?? "all", args.timeoutMs ?? 120_000, args.readLines ?? 200);
        const payload = JSON.parse(collected.content[0].text);
        payload.failed = [
            ...(payload.failed ?? []),
            ...ambiguous.map((receipt) => ({
                target: receipt.target,
                receipt: receiptToken(receipt),
                stage: "delivery",
                error: "delivery_ambiguous",
            })),
        ];
        return ok(JSON.stringify(payload, null, 2));
    });
}
export async function collectLeasedTargets(args, suppliedDependencies = defaultDependencies) {
    if (args.receipts.length < 1 || args.receipts.length > 8) {
        throw new Error("collect requires between one and eight receipt tokens");
    }
    const receiptIds = args.receipts.map(decodeHandoffReceipt);
    if (new Set(receiptIds).size !== receiptIds.length)
        throw new Error("collect receipts must be unique");
    const dependencies = resolvedDependencies(suppliedDependencies);
    await assertControllerAuthority(dependencies.controller, args.controllerId, args.controllerLeaseId, args.controllerFenceToken);
    return withReservations(mutationReservations(dependencies), async () => {
        const receipts = await Promise.all(receiptIds.map((receiptId) => dependencies.receiptStore.get(receiptId)));
        if (receipts.some((receipt) => receipt.controllerId !== args.controllerId)) {
            throw new Error("handoff receipt belongs to a different controller");
        }
        if (receipts.some((receipt) => receipt.state !== "pending" && receipt.state !== "completed")) {
            throw new Error("collect requires pending or completed handoff receipts");
        }
        const resolved = await resolveTargets(dependencies.leaseStores, args.controllerId, receipts.map((receipt) => receipt.target));
        for (const receipt of receipts) {
            const target = resolved.get(receipt.target);
            if (!target ||
                target.leaseId !== receipt.targetLeaseId ||
                target.paneId !== receipt.paneId ||
                target.agentKind !== receipt.agentKind ||
                resolve(target.cwd) !== resolve(receipt.cwd)) {
                await failReceipt(dependencies, receipt, "identity_changed");
            }
        }
        await assertControllerAuthority(dependencies.controller, args.controllerId, args.controllerLeaseId, args.controllerFenceToken);
        return collectReceipts(dependencies, receipts, args.mode ?? "all", args.timeoutMs ?? 120_000, args.readLines ?? 200);
    });
}
async function abandonHandoffReceipt(args, suppliedDependencies) {
    const receiptId = decodeHandoffReceipt(args.receipt);
    const dependencies = resolvedDependencies(suppliedDependencies);
    await assertControllerAuthority(dependencies.controller, args.controllerId, args.controllerLeaseId, args.controllerFenceToken);
    return withReservations(mutationReservations(dependencies), async () => {
        const receipt = await dependencies.receiptStore.get(receiptId);
        if (receipt.controllerId !== args.controllerId) {
            throw new Error("handoff receipt belongs to a different controller");
        }
        if (!outstandingReceiptStates.has(receipt.state)) {
            throw new Error(`handoff receipt is ${receipt.state}, not outstanding`);
        }
        const resolved = await resolveTargets(dependencies.leaseStores, args.controllerId, [receipt.target]);
        const target = resolved.get(receipt.target);
        if (!target ||
            target.leaseId !== receipt.targetLeaseId ||
            target.paneId !== receipt.paneId ||
            target.agentKind !== receipt.agentKind ||
            resolve(target.cwd) !== resolve(receipt.cwd)) {
            throw new Error("handoff target identity changed; reconcile the lifecycle lease first");
        }
        const snapshotResult = await dependencies.run(["agent", "get", receipt.paneId], { timeoutMs: 30_000 });
        const snapshot = { ...extractAgentSnapshot(snapshotResult.json), target: receipt.target };
        if (snapshot.name !== receipt.target ||
            snapshot.paneId !== receipt.paneId ||
            snapshot.kind !== receipt.agentKind ||
            !snapshot.cwd || resolve(snapshot.cwd) !== resolve(receipt.cwd) ||
            !settledAgentStates.has(snapshot.status)) {
            throw new Error("handoff target is not the exact settled leased agent; refusing to release the barrier");
        }
        await assertControllerAuthority(dependencies.controller, args.controllerId, args.controllerLeaseId, args.controllerFenceToken);
        const abandoned = {
            ...receipt,
            state: "failed",
            failure: "abandoned",
            updatedAt: dependencies.now().toISOString(),
        };
        await dependencies.receiptStore.update(abandoned);
        return ok(JSON.stringify({
            receipt: receiptToken(abandoned),
            target: abandoned.target,
            state: abandoned.state,
            failure: abandoned.failure,
            observedStatus: snapshot.status,
            observedSeq: snapshot.stateChangeSeq,
        }, null, 2));
    });
}
async function listHandoffReceipts(controllerId, suppliedDependencies) {
    const dependencies = resolvedDependencies(suppliedDependencies);
    const receipts = (await dependencies.receiptStore.list())
        .filter((receipt) => !controllerId || receipt.controllerId === controllerId)
        .map((receipt) => ({
        receipt: receiptToken(receipt),
        controllerId: receipt.controllerId,
        target: receipt.target,
        paneId: receipt.paneId,
        agentKind: receipt.agentKind,
        cwd: receipt.cwd,
        state: receipt.state,
        beforeSeq: receipt.beforeSeq,
        afterSeq: receipt.afterSeq,
        settledSeq: receipt.settledSeq,
        failure: receipt.failure,
        createdAt: receipt.createdAt,
        updatedAt: receipt.updatedAt,
    }));
    return ok(JSON.stringify({ receipts }, null, 2));
}
export function createCompositeTools(suppliedDependencies = defaultDependencies) {
    return [
        {
            name: "herdr_relay",
            description: "Submit a prompt to one active leased agent and return a durable receipt for later collection.",
            inputSchema: {
                ...controllerCredentials,
                target: targetSchema,
                text: z.string().min(1).describe("Message/prompt to deliver to the agent."),
                submit: z.boolean().optional().describe("Must remain true."),
            },
            run: async (a) => {
                if (a.submit === false)
                    throw new Error("herdr_relay requires submit=true");
                return executeBatch({
                    controllerId: String(a.controller_id),
                    controllerLeaseId: String(a.controller_lease_id),
                    controllerFenceToken: String(a.controller_fence_token),
                    requests: [{ target: String(a.target), message: String(a.text) }],
                    mode: "none",
                }, suppliedDependencies);
            },
        },
        {
            name: "herdr_handoff",
            description: "Prompt one active leased agent and collect the exact receipt-bound settled result.",
            inputSchema: {
                ...controllerCredentials,
                target: targetSchema,
                message: z.string().min(1).describe("Task/prompt to hand to the agent."),
                wait_status: z.enum(["idle", "working", "blocked", "done", "unknown"]).optional()
                    .describe("Deprecated compatibility option; collection returns the first settled state."),
                timeout_ms: z.number().int().positive().max(600_000).optional(),
                read_lines: z.number().int().positive().max(2000).optional(),
            },
            timeoutMs: 620_000,
            run: async (a) => executeBatch({
                controllerId: String(a.controller_id),
                controllerLeaseId: String(a.controller_lease_id),
                controllerFenceToken: String(a.controller_fence_token),
                requests: [{ target: String(a.target), message: String(a.message) }],
                mode: "all",
                timeoutMs: a.timeout_ms,
                readLines: a.read_lines,
            }, suppliedDependencies),
        },
        {
            name: "herdr_batch_handoff",
            description: "Deliver up to eight independent tasks to active leased agents and collect exact receipt-bound results.",
            inputSchema: {
                ...controllerCredentials,
                requests: z.array(z.object({ target: targetSchema, message: z.string().min(1) })).min(1).max(8),
                mode: z.enum(["all", "first"]).optional(),
                timeout_ms: z.number().int().positive().max(600_000).optional(),
                read_lines: z.number().int().positive().max(2000).optional(),
            },
            timeoutMs: 620_000,
            run: async (a) => executeBatch({
                controllerId: String(a.controller_id),
                controllerLeaseId: String(a.controller_lease_id),
                controllerFenceToken: String(a.controller_fence_token),
                requests: a.requests.map((request) => ({
                    target: String(request.target),
                    message: String(request.message),
                })),
                mode: a.mode,
                timeoutMs: a.timeout_ms,
                readLines: a.read_lines,
            }, suppliedDependencies),
        },
        {
            name: "herdr_collect_handoffs",
            description: "Collect one to eight pending handoff receipts without submitting another prompt.",
            inputSchema: {
                ...controllerCredentials,
                receipts: z.array(z.string().min(1)).min(1).max(8),
                mode: z.enum(["all", "first"]).optional(),
                timeout_ms: z.number().int().positive().max(600_000).optional(),
                read_lines: z.number().int().positive().max(2000).optional(),
            },
            timeoutMs: 620_000,
            run: async (a) => collectLeasedTargets({
                controllerId: String(a.controller_id),
                controllerLeaseId: String(a.controller_lease_id),
                controllerFenceToken: String(a.controller_fence_token),
                receipts: a.receipts.map(String),
                mode: a.mode,
                timeoutMs: a.timeout_ms,
                readLines: a.read_lines,
            }, suppliedDependencies),
        },
        {
            name: "herdr_handoff_receipt_list",
            description: "List content-free handoff receipts and their collection state.",
            inputSchema: {
                controller_id: z.string().min(1).max(100).optional(),
            },
            run: async (a) => listHandoffReceipts(a.controller_id === undefined ? undefined : String(a.controller_id), suppliedDependencies),
        },
        {
            name: "herdr_handoff_receipt_abandon",
            description: "Explicitly release an outstanding handoff barrier only after its exact leased agent is settled.",
            inputSchema: {
                ...controllerCredentials,
                receipt: z.string().min(1),
            },
            run: async (a) => abandonHandoffReceipt({
                controllerId: String(a.controller_id),
                controllerLeaseId: String(a.controller_lease_id),
                controllerFenceToken: String(a.controller_fence_token),
                receipt: String(a.receipt),
            }, suppliedDependencies),
        },
    ];
}
export const compositeTools = createCompositeTools();
//# sourceMappingURL=composite.js.map