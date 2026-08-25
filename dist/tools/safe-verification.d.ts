import { type GitResult } from "../git.js";
import { type HerdrResult } from "../herdr.js";
import { WriterLeaseStore } from "../lease-store.js";
import { type ControllerAuthorityDependencies } from "./safe-controller.js";
import { type ToolDef } from "./types.js";
type GitRunner = (args: string[], opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}) => Promise<GitResult>;
type HerdrRunner = (args: string[], opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}) => Promise<HerdrResult>;
export interface CommandResult {
    argv: string[];
    durationMs: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdoutTail: string;
    stderrTail: string;
    stdoutSha256: string;
    stderrSha256: string;
}
type CommandRunner = (executable: string, args: string[], options: {
    cwd: string;
    gitCommonDir: string;
    stateDir: string;
    allowNetwork: boolean;
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
    runId: string;
    readOnlyFiles?: Array<{
        source: string;
        destination: string;
    }>;
}) => Promise<CommandResult>;
export type VerificationState = "running" | "passed" | "failed" | "timed_out" | "preflight_failed" | "invalidated";
export interface VerificationRecord {
    version: 1;
    runId: string;
    controllerId: string;
    controllerGeneration: number;
    writerLeaseId: string;
    ticketRef: string;
    worktree: string;
    branch: string;
    baseCommit: string;
    headCommit: string;
    worktreeSha256: string;
    selectedGate?: string;
    bootstrapWeb: boolean;
    bootstrapPythonLocks?: string[];
    state: VerificationState;
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    exitCode?: number | null;
    command?: string[];
    stdoutSha256?: string;
    stderrSha256?: string;
    afterWorktreeSha256?: string;
    failure?: string;
}
export declare class VerificationRecordStore {
    readonly directory: string;
    constructor(stateDir?: string);
    create(record: VerificationRecord): Promise<void>;
    update(record: VerificationRecord): Promise<void>;
    list(controllerId?: string, writerLeaseId?: string): Promise<VerificationRecord[]>;
    private ensureDirectory;
    private pathFor;
    private serialize;
    private parse;
}
export interface SafeVerificationDependencies {
    git: GitRunner;
    herdr: HerdrRunner;
    writers: WriterLeaseStore;
    records: VerificationRecordStore;
    controller: ControllerAuthorityDependencies;
    command: CommandRunner;
    now: () => Date;
    uuid: () => string;
    stateDir: string;
    platform?: NodeJS.Platform;
    executableAvailable?: (name: string) => Promise<boolean>;
}
export declare function runCommand(executable: string, args: string[], options: {
    cwd: string;
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
}): Promise<CommandResult>;
export declare function buildNetworkResolverBindArgs(resolverPath: string): string[];
export declare function runSandboxedCommand(executable: string, args: string[], options: {
    cwd: string;
    gitCommonDir: string;
    stateDir: string;
    allowNetwork: boolean;
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
    runId: string;
    readOnlyFiles?: Array<{
        source: string;
        destination: string;
    }>;
}): Promise<CommandResult>;
export declare function createSafeVerificationTools(dependencies?: SafeVerificationDependencies): ToolDef[];
export declare const safeVerificationTools: ToolDef[];
export {};
