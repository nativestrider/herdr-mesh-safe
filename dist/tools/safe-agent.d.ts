import { type HerdrResult } from "../herdr.js";
import { LeaseStore } from "../lease-store.js";
import { type ToolDef } from "./types.js";
export interface AgentSnapshot {
    target: string;
    kind?: string;
    status: string;
    cwd?: string;
    name?: string;
    paneId: string;
    stateChangeSeq: number;
}
type Runner = (args: string[], opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}) => Promise<HerdrResult>;
export interface SafeAgentDependencies {
    run: Runner;
    store: LeaseStore;
    now: () => Date;
    uuid: () => string;
}
export declare function buildSettledWaitArgs(target: string, timeoutMs: number): string[];
export declare function buildPaneSplitArgs(parentPaneId: string, direction: string, cwd: string): string[];
export declare function buildAgentStartArgs(name: string, kind: string, paneId: string, timeoutMs: number): string[];
export declare function buildPaneCloseArgs(paneId: string): string[];
export declare function extractAgentSnapshot(json: unknown): AgentSnapshot;
export declare function extractAgentSnapshots(json: unknown): AgentSnapshot[];
export declare function extractPaneId(json: unknown): string;
export declare function createSafeAgentTools(dependencies?: SafeAgentDependencies): ToolDef[];
export declare const safeAgentTools: ToolDef[];
export {};
