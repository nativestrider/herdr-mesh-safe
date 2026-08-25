import { z } from "zod";
import { type HerdrResult } from "../herdr.js";
import { ControllerLeaseStore, type ControllerLease } from "../lease-store.js";
import { type ToolDef } from "./types.js";
type Runner = (args: string[], opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}) => Promise<HerdrResult>;
export interface ControllerAuthorityDependencies {
    store: ControllerLeaseStore;
    now: () => Date;
    callerPaneId?: string;
}
export interface SafeControllerDependencies extends ControllerAuthorityDependencies {
    run: Runner;
    uuid: () => string;
}
export declare const defaultControllerAuthorityDependencies: ControllerAuthorityDependencies;
export declare function assertControllerAuthority(dependencies: ControllerAuthorityDependencies, controllerId: string, leaseId: string, fenceToken: string): Promise<ControllerLease>;
export declare const controllerCredentials: {
    controller_id: z.ZodString;
    controller_lease_id: z.ZodString;
    controller_fence_token: z.ZodString;
};
export declare function createSafeControllerTools(dependencies?: SafeControllerDependencies): ToolDef[];
export declare const safeControllerTools: ToolDef[];
export {};
