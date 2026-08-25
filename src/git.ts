import { execFile } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export async function runGit(
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GitResult> {
  const timeout = opts.timeoutMs ?? 30_000;
  return new Promise<GitResult>((resolve, reject) => {
    execFile(
      "git",
      args,
      { timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", signal: opts.signal },
      (error, stdout, stderr) => {
        const out = stdout ?? "";
        const err = stderr ?? "";
        if (!error) {
          resolve({ stdout: out, stderr: err });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ABORT_ERR" || opts.signal?.aborted) {
          reject(new GitError(`git command cancelled: git ${args.join(" ")}`));
          return;
        }
        if ((error as { killed?: boolean }).killed) {
          reject(new GitError(`git command timed out after ${timeout}ms: git ${args.join(" ")}`));
          return;
        }
        reject(new GitError(`git ${args.join(" ")} failed: ${(err || out || error.message).trim()}`));
      },
    );
  });
}
