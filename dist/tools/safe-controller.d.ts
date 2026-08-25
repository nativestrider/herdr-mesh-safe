import { z } from "zod";
import { type HerdrResult } from "../herdr.js";
import { ControllerLeaseStore, type ControllerLease } from "../lease-store.js";
import { type ProcessIdentity } from "../process-attestation.js";
import { type ToolDef } from "./types.js";
type Runner = (args: string[], opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}) => Promise<HerdrResult>;
export interface ControllerAuthorityDependencies {
    store: ControllerLeaseStore;
    now: () => Date;
    callerPaneId?: string;
    callerProcessId?: number;
    processDescendsFrom?: (callerPid: number, expected: ProcessIdentity) => Promise<boolean>;
}
export interface SafeControllerDependencies extends ControllerAuthorityDependencies {
    run: Runner;
    uuid: () => string;
    controllerProcessIdentity?: () => Promise<ProcessIdentity | undefined>;
}
export declare const defaultControllerAuthorityDependencies: ControllerAuthorityDependencies;
export declare function currentCallerControllerAuthority(controllerId: string, dependencies?: SafeControllerDependencies): Promise<ControllerLease>;
export declare function assertControllerAuthority(dependencies: ControllerAuthorityDependencies, controllerId: string, leaseId: string, fenceToken: string): Promise<ControllerLease>;
export declare const controllerCredentials: {
    controller_id: z.ZodString;
    controller_lease_id: z.ZodString;
    controller_fence_token: z.ZodString;
};
export declare function createSafeControllerTools(dependencies?: SafeControllerDependencies): ToolDef[];
export declare const safeControllerTools: ToolDef[];
export {};
