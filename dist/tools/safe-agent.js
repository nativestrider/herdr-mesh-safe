import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { HerdrError, runHerdr } from "../herdr.js";
import { LeaseStore } from "../lease-store.js";
import { assertControllerAuthority, controllerCredentials, defaultControllerAuthorityDependencies, } from "./safe-controller.js";
import { ok, targetSchema } from "./types.js";
const settledStatuses = new Set(["idle", "done", "blocked"]);
export const MIN_AGENT_START_TIMEOUT_MS = 3_001;
const agentKinds = [
    "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp",
    "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok",
    "hermes", "kilo", "qodercli", "maki",
];
const defaultDependencies = {
    run: runHerdr,
    store: new LeaseStore(),
    controller: defaultControllerAuthorityDependencies,
    now: () => new Date(),
    uuid: randomUUID,
    pause: (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)),
};
export function buildSettledWaitArgs(target, timeoutMs) {
    return ["agent", "wait", target, "--timeout", String(timeoutMs)];
}
export function buildTabCreateArgs(workspaceId, cwd, label) {
    return ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"];
}
export function buildAgentStartArgs(name, kind, paneId, timeoutMs, model, effort) {
    const args = ["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(timeoutMs)];
    if (model || effort) {
        if (kind !== "claude")
            throw new Error("explicit reviewer model and effort are currently supported only for Claude");
        args.push("--");
        if (model)
            args.push("--model", model);
        if (effort)
            args.push("--effort", effort);
    }
    return args;
}
function isAgentPaneBusy(error) {
    return error instanceof Error && error.message.includes("agent_pane_busy");
}
export async function startAgentWhenShellReady(run, name, kind, paneId, timeoutMs, model, effort, pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)), nowMilliseconds = Date.now) {
    const intervalMs = 100;
    const readinessBudgetMs = Math.max(timeoutMs, MIN_AGENT_START_TIMEOUT_MS);
    const deadline = nowMilliseconds() + readinessBudgetMs;
    let lastError;
    let attempted = false;
    while (!attempted || nowMilliseconds() < deadline) {
        const timeRemainingMs = deadline - nowMilliseconds();
        if (attempted && timeRemainingMs < MIN_AGENT_START_TIMEOUT_MS)
            break;
        const probeTimeoutMs = Math.max(MIN_AGENT_START_TIMEOUT_MS, Math.min(readinessBudgetMs, timeRemainingMs));
        attempted = true;
        try {
            await run(buildAgentStartArgs(name, kind, paneId, probeTimeoutMs, model, effort), { timeoutMs: probeTimeoutMs + 1_000 });
            return;
        }
        catch (error) {
            if (!isAgentPaneBusy(error))
                throw error;
            lastError = error;
            const timeLeft = deadline - nowMilliseconds();
            if (timeLeft <= 0)
                break;
            await pause(Math.min(intervalMs, timeLeft));
        }
    }
    throw lastError ?? new Error("timed out waiting for the target pane to become an available shell");
}
export function buildPaneCloseArgs(paneId) {
    return ["pane", "close", paneId];
}
function findObject(node, predicate) {
    if (!node || typeof node !== "object")
        return undefined;
    if (Array.isArray(node)) {
        for (const value of node) {
            const found = findObject(value, predicate);
            if (found)
                return found;
        }
        return undefined;
    }
    const record = node;
    if (predicate(record))
        return record;
    for (const value of Object.values(record)) {
        const found = findObject(value, predicate);
        if (found)
            return found;
    }
    return undefined;
}
export function extractAgentSnapshot(json) {
    const value = findObject(json, (record) => typeof record.pane_id === "string" && typeof record.agent_status === "string");
    if (!value)
        throw new Error("Herdr response did not contain an agent snapshot");
    const target = typeof value.name === "string" ? value.name : String(value.pane_id);
    return {
        target,
        kind: typeof value.agent === "string" ? value.agent : undefined,
        status: String(value.agent_status),
        cwd: typeof value.cwd === "string" ? value.cwd : undefined,
        name: typeof value.name === "string" ? value.name : undefined,
        paneId: String(value.pane_id),
        stateChangeSeq: typeof value.state_change_seq === "number" ? value.state_change_seq : 0,
    };
}
export function extractAgentSnapshots(json) {
    const snapshots = [];
    const visit = (node) => {
        if (!node || typeof node !== "object")
            return;
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        const value = node;
        if (typeof value.pane_id === "string" && typeof value.agent_status === "string") {
            snapshots.push(extractAgentSnapshot(value));
            return;
        }
        Object.values(value).forEach(visit);
    };
    visit(json);
    return snapshots;
}
export function extractPaneId(json) {
    const value = findObject(json, (record) => typeof record.pane_id === "string");
    if (!value)
        throw new Error("Herdr response did not contain a pane id");
    return String(value.pane_id);
}
export function extractWorkspaceId(json) {
    const value = findObject(json, (record) => typeof record.workspace_id === "string");
    if (!value)
        throw new Error("Herdr response did not contain a workspace id");
    return String(value.workspace_id);
}
function remaining(deadline) {
    const value = deadline - Date.now();
    if (value <= 0)
        throw new HerdrError("timed out waiting for a new settled agent state");
    return value;
}
function isTimeout(error) {
    return error instanceof Error && error.message.includes("timed out");
}
async function getSnapshot(run, target, signal) {
    const result = await run(["agent", "get", target], { timeoutMs: 30_000, signal });
    return { ...extractAgentSnapshot(result.json), target };
}
export async function waitForSettled(run, target, timeoutMs, afterSeq, signal) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const snapshot = await getSnapshot(run, target, signal);
        const isNew = afterSeq === undefined || snapshot.stateChangeSeq > afterSeq;
        if (isNew && settledStatuses.has(snapshot.status))
            return snapshot;
        const timeout = remaining(deadline);
        const args = snapshot.status === "working"
            ? buildSettledWaitArgs(target, timeout)
            : ["agent", "wait", target, "--until", "working", "--timeout", String(Math.min(timeout, 5000))];
        try {
            await run(args, { timeoutMs: timeout + 2000, signal });
        }
        catch (error) {
            if (!isTimeout(error))
                throw error;
        }
    }
}
async function readVisible(run, target, lines) {
    const result = await run([
        "agent", "read", target, "--source", "visible", "--lines", String(lines), "--format", "text",
    ]);
    return result.stdout.trim();
}
async function settledResult(run, snapshot, lines) {
    const output = await readVisible(run, snapshot.target, lines);
    return ok(JSON.stringify({ event: "agent_settled", agent: snapshot, output }, null, 2));
}
function validateLeaseOwner(lease, controllerId) {
    if (lease.controllerId !== controllerId)
        throw new Error("reviewer lease belongs to a different controller");
}
async function validateLeaseIdentity(run, lease) {
    const snapshot = await getSnapshot(run, lease.agentName);
    if (snapshot.paneId !== lease.paneId ||
        snapshot.name !== lease.agentName ||
        snapshot.kind !== lease.agentKind ||
        !snapshot.cwd || resolve(snapshot.cwd) !== resolve(lease.cwd)) {
        throw new Error("reviewer identity no longer matches its lease; refusing lifecycle action");
    }
    return snapshot;
}
async function closeOwnedReviewer(dependencies, leaseId, controllerId, controllerLeaseId, controllerFenceToken, expectedStateChangeSeq, lines) {
    await assertControllerAuthority(dependencies.controller, controllerId, controllerLeaseId, controllerFenceToken);
    const { closing, output } = await dependencies.store.withExclusiveReservation(async () => {
        const lease = await dependencies.store.get(leaseId);
        validateLeaseOwner(lease, controllerId);
        if (lease.state !== "active")
            throw new Error(`reviewer lease is ${lease.state}, not active`);
        const snapshot = await validateLeaseIdentity(dependencies.run, lease);
        if (!settledStatuses.has(snapshot.status) || snapshot.status === "blocked") {
            throw new Error(`reviewer is ${snapshot.status}; only idle or done reviewers may be closed`);
        }
        if (snapshot.stateChangeSeq !== expectedStateChangeSeq) {
            throw new Error(`agent state cursor is ${snapshot.stateChangeSeq}, expected ${expectedStateChangeSeq}`);
        }
        const output = await readVisible(dependencies.run, lease.agentName, lines);
        const finalSnapshot = await validateLeaseIdentity(dependencies.run, lease);
        if ((finalSnapshot.status !== "idle" && finalSnapshot.status !== "done") ||
            finalSnapshot.stateChangeSeq !== snapshot.stateChangeSeq) {
            throw new Error("agent state changed while capturing output; refusing to close the pane");
        }
        const captureSha256 = createHash("sha256").update(output).digest("hex");
        const closing = { ...lease, state: "closing", captureSha256 };
        await dependencies.store.update(closing);
        return { closing, output };
    });
    await assertControllerAuthority(dependencies.controller, controllerId, controllerLeaseId, controllerFenceToken);
    try {
        await dependencies.run(buildPaneCloseArgs(closing.paneId));
    }
    catch (error) {
        await dependencies.store.update({
            ...closing,
            state: "close_failed",
            failure: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
    const closed = {
        ...closing,
        state: "closed",
        closedAt: dependencies.now().toISOString(),
    };
    await dependencies.store.update(closed);
    return { lease: closed, terminalOutput: output };
}
export function createSafeAgentTools(dependencies = defaultDependencies) {
    return [
        {
            name: "herdr_agent_wait_settled",
            description: "Wait for an agent to become idle, done, or blocked, then return its state and visible output. Use after_seq to wait for a newer state transition instead of accepting stale terminal state.",
            inputSchema: {
                target: targetSchema,
                after_seq: z.number().int().nonnegative().optional(),
                timeout_ms: z.number().int().positive().max(600_000).optional(),
                read_lines: z.number().int().positive().max(2000).optional(),
            },
            run: async (args) => {
                const snapshot = await waitForSettled(dependencies.run, String(args.target), args.timeout_ms ?? 600_000, args.after_seq);
                return settledResult(dependencies.run, snapshot, args.read_lines ?? 200);
            },
        },
        {
            name: "herdr_agent_wait_any",
            description: "Wait concurrently for the first of several agents to become idle, done, or blocked. Losing waits are cancelled. Per-target after_seq cursors prevent stale terminal states.",
            inputSchema: {
                targets: z.array(z.object({ target: targetSchema, after_seq: z.number().int().nonnegative().optional() })).min(1).max(16),
                timeout_ms: z.number().int().positive().max(600_000).optional(),
                read_lines: z.number().int().positive().max(2000).optional(),
            },
            run: async (args) => {
                const targets = args.targets;
                const timeout = args.timeout_ms ?? 600_000;
                const controllers = targets.map(() => new AbortController());
                const waits = targets.map((target, index) => waitForSettled(dependencies.run, String(target.target), timeout, target.after_seq, controllers[index].signal));
                try {
                    const snapshot = await Promise.any(waits);
                    controllers.forEach((controller) => controller.abort());
                    return settledResult(dependencies.run, snapshot, args.read_lines ?? 200);
                }
                catch (error) {
                    controllers.forEach((controller) => controller.abort());
                    throw error;
                }
            },
        },
        {
            name: "herdr_owned_reviewer_start",
            description: "Create a dedicated no-focus tab in the controller's workspace, start one supported reviewer in its root pane, verify its identity, and persist a lease. This never splits the controller tab and does not accept arbitrary shell commands or agent arguments.",
            inputSchema: {
                ...controllerCredentials,
                purpose: z.string().min(1).max(500),
                parent_pane_id: z.string().regex(/^[A-Za-z0-9]+:[A-Za-z0-9]+$/),
                cwd: z.string().min(1),
                name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
                kind: z.enum(agentKinds),
                model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/).optional(),
                effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
                start_timeout_ms: z.number().int().min(MIN_AGENT_START_TIMEOUT_MS).max(300_000).optional(),
            },
            run: async (args) => {
                await assertControllerAuthority(dependencies.controller, String(args.controller_id), String(args.controller_lease_id), String(args.controller_fence_token));
                const cwdInput = String(args.cwd);
                if (!isAbsolute(cwdInput))
                    throw new Error("reviewer cwd must be absolute");
                const cwd = await realpath(cwdInput);
                if (!(await stat(cwd)).isDirectory())
                    throw new Error("reviewer cwd is not a directory");
                const parentPaneId = String(args.parent_pane_id);
                const parentPane = await dependencies.run(["pane", "get", parentPaneId]);
                const workspaceId = extractWorkspaceId(parentPane.json);
                const tab = await dependencies.run(buildTabCreateArgs(workspaceId, cwd, String(args.name)));
                const paneId = extractPaneId(tab.json);
                const lease = {
                    version: 1,
                    leaseId: dependencies.uuid(),
                    controllerId: String(args.controller_id),
                    purpose: String(args.purpose),
                    parentPaneId,
                    paneId,
                    agentName: String(args.name),
                    agentKind: String(args.kind),
                    cwd,
                    state: "provisioning",
                    createdAt: dependencies.now().toISOString(),
                };
                try {
                    await dependencies.store.create(lease);
                }
                catch (error) {
                    await dependencies.run(buildPaneCloseArgs(paneId));
                    throw error;
                }
                try {
                    const startTimeout = args.start_timeout_ms ?? 30_000;
                    await startAgentWhenShellReady(dependencies.run, lease.agentName, lease.agentKind, paneId, startTimeout, args.model, args.effort, dependencies.pause);
                    await validateLeaseIdentity(dependencies.run, lease);
                    const active = { ...lease, state: "active" };
                    await dependencies.store.update(active);
                    return ok(JSON.stringify({ lease: active }, null, 2));
                }
                catch (error) {
                    try {
                        await dependencies.run(buildPaneCloseArgs(paneId));
                        await dependencies.store.update({
                            ...lease,
                            state: "failed_closed",
                            closedAt: dependencies.now().toISOString(),
                            failure: error instanceof Error ? error.message : String(error),
                        });
                    }
                    catch (closeError) {
                        await dependencies.store.update({
                            ...lease,
                            state: "orphaned",
                            failure: `${error instanceof Error ? error.message : String(error)}; rollback failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
                        });
                    }
                    throw error;
                }
            },
        },
        {
            name: "herdr_owned_reviewer_list",
            description: "List persistent reviewer leases, optionally limited to one controller. This is read-only.",
            inputSchema: { controller_id: z.string().min(1).max(100).optional() },
            run: async (args) => ok(JSON.stringify({ leases: await dependencies.store.list(args.controller_id) }, null, 2)),
        },
        {
            name: "herdr_owned_reviewer_close",
            description: "Capture and close only an idle or done reviewer whose pane, agent kind, name, cwd, controller, and lease still match. Blocked or working reviewers are refused.",
            inputSchema: {
                lease_id: z.string().uuid(),
                ...controllerCredentials,
                expected_state_change_seq: z.number().int().nonnegative(),
                read_lines: z.number().int().positive().max(2000).optional(),
            },
            run: async (args) => ok(JSON.stringify(await closeOwnedReviewer(dependencies, String(args.lease_id), String(args.controller_id), String(args.controller_lease_id), String(args.controller_fence_token), Number(args.expected_state_change_seq), args.read_lines ?? 500), null, 2)),
        },
        {
            name: "herdr_owned_reviewer_cleanup",
            description: "Inspect reviewer leases for one controller and optionally close only identity-matched idle/done reviewers. Dry-run is the default; blocked, working, and ambiguous leases are preserved.",
            inputSchema: {
                ...controllerCredentials,
                dry_run: z.boolean().optional(),
                read_lines: z.number().int().positive().max(2000).optional(),
            },
            run: async (args) => {
                const controllerId = String(args.controller_id);
                const dryRun = args.dry_run !== false;
                await assertControllerAuthority(dependencies.controller, controllerId, String(args.controller_lease_id), String(args.controller_fence_token));
                const results = [];
                for (const lease of await dependencies.store.list(controllerId)) {
                    if (lease.state !== "active")
                        continue;
                    try {
                        const snapshot = await validateLeaseIdentity(dependencies.run, lease);
                        if (!settledStatuses.has(snapshot.status) || snapshot.status === "blocked") {
                            results.push({ leaseId: lease.leaseId, action: "preserved", status: snapshot.status });
                        }
                        else if (dryRun) {
                            results.push({ leaseId: lease.leaseId, action: "would_close", status: snapshot.status });
                        }
                        else {
                            results.push({ leaseId: lease.leaseId, action: "closed", result: await closeOwnedReviewer(dependencies, lease.leaseId, controllerId, String(args.controller_lease_id), String(args.controller_fence_token), snapshot.stateChangeSeq, args.read_lines ?? 500) });
                        }
                    }
                    catch (error) {
                        results.push({ leaseId: lease.leaseId, action: "preserved", error: error instanceof Error ? error.message : String(error) });
                    }
                }
                return ok(JSON.stringify({ dryRun, results }, null, 2));
            },
        },
    ];
}
export const safeAgentTools = createSafeAgentTools();
//# sourceMappingURL=safe-agent.js.map