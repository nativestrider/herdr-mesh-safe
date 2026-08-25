import { runHerdr } from "../herdr.js";
import { type ControllerAuthorityDependencies } from "./safe-controller.js";
import { type ToolDef } from "./types.js";
export declare function buildRelayArgs(target: string, text: string): string[];
export declare function buildHandoffPromptArgs(target: string, message: string, status: string | undefined, timeout: number): string[];
type Runner = typeof runHerdr;
interface CompositeDependencies {
    run: Runner;
    controller: ControllerAuthorityDependencies;
    leaseStores?: PromptLeaseStore[];
}
interface PromptLease {
    leaseId?: string;
    agentName: string;
    paneId?: string;
    controllerId: string;
    state: string;
}
interface PromptLeaseStore {
    list(): Promise<PromptLease[]>;
    withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T>;
}
export declare function createCompositeTools(dependencies?: CompositeDependencies): ToolDef[];
export declare const compositeTools: ToolDef[];
export {};
