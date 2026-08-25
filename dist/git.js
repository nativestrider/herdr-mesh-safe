import { execFile } from "node:child_process";
export class GitError extends Error {
    constructor(message) {
        super(message);
        this.name = "GitError";
    }
}
export async function runGit(args, opts = {}) {
    const timeout = opts.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
        execFile("git", args, { timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", signal: opts.signal }, (error, stdout, stderr) => {
            const out = stdout ?? "";
            const err = stderr ?? "";
            if (!error) {
                resolve({ stdout: out, stderr: err });
                return;
            }
            const code = error.code;
            if (code === "ABORT_ERR" || opts.signal?.aborted) {
                reject(new GitError(`git command cancelled: git ${args.join(" ")}`));
                return;
            }
            if (error.killed) {
                reject(new GitError(`git command timed out after ${timeout}ms: git ${args.join(" ")}`));
                return;
            }
            reject(new GitError(`git ${args.join(" ")} failed: ${(err || out || error.message).trim()}`));
        });
    });
}
//# sourceMappingURL=git.js.map