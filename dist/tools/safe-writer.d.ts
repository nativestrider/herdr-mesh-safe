import { type GitResult } from "../git.js";
import { type HerdrResult } from "../herdr.js";
import { WriterLeaseStore } from "../lease-store.js";
import { type ControllerAuthorityDependencies } from "./safe-controller.js";
import { type ToolDef } from "./types.js";
type HerdrRunner = (args: string[], opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}) => Promise<HerdrResult>;
type GitRunner = (args: string[], opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}) => Promise<GitResult>;
export interface SafeWriterDependencies {
    herdr: HerdrRunner;
    git: GitRunner;
    store: WriterLeaseStore;
    controller: ControllerAuthorityDependencies;
    now: () => Date;
    uuid: () => string;
    pause?: (milliseconds: number) => Promise<void>;
}
export declare function hashGitStatus(status: string): string;
export declare function normalizeOwnershipScopes(scopes: string[]): string[];
export declare function ownershipScopesOverlap(left: string[], right: string[]): boolean;
export declare function createSafeWriterTools(dependencies?: SafeWriterDependencies): ToolDef[];
export declare const safeWriterTools: ToolDef[];
export {};
