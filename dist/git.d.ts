export interface GitResult {
    stdout: string;
    stderr: string;
}
export declare class GitError extends Error {
    constructor(message: string);
}
export declare function runGit(args: string[], opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<GitResult>;
