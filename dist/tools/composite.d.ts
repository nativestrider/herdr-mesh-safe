import { runHerdr } from "../herdr.js";
import { type HandoffReceipt } from "../lease-store.js";
import { type ControllerAuthorityDependencies } from "./safe-controller.js";
import { type ToolDef, type ToolResult } from "./types.js";
export declare function buildRelayArgs(target: string, text: string): string[];
export declare function buildHandoffPromptArgs(target: string, message: string, status: string | undefined, timeout: number): string[];
type Runner = typeof runHerdr;
interface PromptLease {
    leaseId?: string;
    agentName: string;
    paneId?: string;
    agentKind?: string;
    cwd?: string;
    worktree?: string;
    controllerId: string;
    state: string;
}
interface Reservable {
    withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T>;
}
interface PromptLeaseStore extends Reservable {
    list(): Promise<PromptLease[]>;
}
interface PromptReceiptStore extends Reservable {
    create(receipt: HandoffReceipt): Promise<void>;
    update(receipt: HandoffReceipt): Promise<void>;
    get(receiptId: string): Promise<HandoffReceipt>;
    list(): Promise<HandoffReceipt[]>;
}
interface CompositeDependencies {
    run: Runner;
    controller: ControllerAuthorityDependencies;
    leaseStores?: PromptLeaseStore[];
    receiptStore?: PromptReceiptStore;
    now?: () => Date;
    uuid?: () => string;
}
export declare function collectLeasedTargets(args: {
    controllerId: string;
    controllerLeaseId: string;
    controllerFenceToken: string;
    receipts: string[];
    mode?: "all" | "first";
    timeoutMs?: number;
    readLines?: number;
}, suppliedDependencies?: CompositeDependencies): Promise<ToolResult>;
export declare function createCompositeTools(suppliedDependencies?: CompositeDependencies): ToolDef[];
export declare const compositeTools: ToolDef[];
export {};
