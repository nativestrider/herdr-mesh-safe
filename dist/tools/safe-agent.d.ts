import { type HerdrResult } from "../herdr.js";
import { LeaseStore } from "../lease-store.js";
import { type ControllerAuthorityDependencies } from "./safe-controller.js";
import { type ToolDef } from "./types.js";
export declare const MIN_AGENT_START_TIMEOUT_MS = 3001;
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
type Pause = (milliseconds: number) => Promise<void>;
export interface SafeAgentDependencies {
    run: Runner;
    store: LeaseStore;
    controller: ControllerAuthorityDependencies;
    now: () => Date;
    uuid: () => string;
    pause?: Pause;
}
export declare function buildSettledWaitArgs(target: string, timeoutMs: number): string[];
export declare function buildTabCreateArgs(workspaceId: string, cwd: string, label: string): string[];
export declare function buildAgentStartArgs(name: string, kind: string, paneId: string, timeoutMs: number, model?: string, effort?: string): string[];
export declare function startAgentWhenShellReady(run: Runner, name: string, kind: string, paneId: string, timeoutMs: number, model?: string, effort?: string, pause?: Pause, nowMilliseconds?: () => number): Promise<void>;
export declare function buildPaneCloseArgs(paneId: string): string[];
export declare function extractAgentSnapshot(json: unknown): AgentSnapshot;
export declare function extractAgentSnapshots(json: unknown): AgentSnapshot[];
export declare function extractPaneId(json: unknown): string;
export declare function extractWorkspaceId(json: unknown): string;
export declare function waitForSettled(run: Runner, target: string, timeoutMs: number, afterSeq?: number, signal?: AbortSignal): Promise<AgentSnapshot>;
export declare function createSafeAgentTools(dependencies?: SafeAgentDependencies): ToolDef[];
export declare const safeAgentTools: ToolDef[];
export {};
