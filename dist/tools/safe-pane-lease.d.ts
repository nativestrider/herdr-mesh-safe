import { type HerdrResult } from "../herdr.js";
import { AdoptedPaneLeaseStore, LeaseStore, WriterLeaseStore } from "../lease-store.js";
import { type ControllerAuthorityDependencies } from "./safe-controller.js";
import { type ToolDef } from "./types.js";
type Runner = (args: string[], opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}) => Promise<HerdrResult>;
export interface SafePaneLeaseDependencies {
    run: Runner;
    adoptedStore: AdoptedPaneLeaseStore;
    reviewerStore: LeaseStore;
    writerStore: WriterLeaseStore;
    controller: ControllerAuthorityDependencies;
    now: () => Date;
    uuid: () => string;
}
export declare function createSafePaneLeaseTools(dependencies?: SafePaneLeaseDependencies): ToolDef[];
export declare const safePaneLeaseTools: ToolDef[];
export {};
