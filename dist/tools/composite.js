import { z } from "zod";
import { runHerdr } from "../herdr.js";
import { ok, formatResult, targetSchema } from "./types.js";
export function buildRelayArgs(target, text) {
    return ["agent", "prompt", target, text];
}
export function buildHandoffPromptArgs(target, message, status, timeout) {
    const argv = ["agent", "prompt", target, message, "--wait"];
    if (status && status !== "idle")
        argv.push("--until", status);
    argv.push("--timeout", String(timeout));
    return argv;
}
export const compositeTools = [
    {
        name: "herdr_relay",
        description: "Deliver and submit a prompt to an agent with the current Herdr agent prompt command.",
        inputSchema: {
            target: targetSchema,
            text: z.string().describe("Message/prompt to deliver to the agent."),
            submit: z
                .boolean()
                .optional()
                .describe("Must remain true; the current bridge supports submitted prompts only."),
        },
        run: async (a) => {
            const target = String(a.target);
            if (a.submit === false) {
                throw new Error("herdr_relay requires submit=true with the installed Herdr CLI");
            }
            await runHerdr(buildRelayArgs(target, String(a.text)));
            return ok(`Delivered to "${target}" and submitted.`);
        },
    },
    {
        name: "herdr_handoff",
        description: "Hand a task to another agent and wait for its result in one step: deliver the message (with Enter), wait until the agent reaches a status (default idle), then read its output back. Use this for review/fix/verify handoffs so the multi-step chain can't break midway. Returns the target agent's resulting output.",
        inputSchema: {
            target: targetSchema,
            message: z.string().describe("Task/prompt to hand to the agent."),
            wait_status: z
                .enum(["idle", "working", "blocked", "done", "unknown"])
                .optional()
                .describe("Status to wait for before reading back (default: idle)."),
            timeout_ms: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Max time to wait for the status (default 120000)."),
            read_lines: z
                .number()
                .int()
                .positive()
                .max(2000)
                .optional()
                .describe("Lines of output to read back (default 200)."),
        },
        timeoutMs: 180_000,
        run: async (a) => {
            const target = String(a.target);
            const status = a.wait_status ?? "idle";
            const timeout = a.timeout_ms ?? 120_000;
            const lines = a.read_lines ?? 200;
            let waitNote = `reached ${status}`;
            try {
                await runHerdr(buildHandoffPromptArgs(target, String(a.message), status, timeout), { timeoutMs: timeout + 10_000 });
            }
            catch (err) {
                // Don't lose the output if the wait times out — read whatever is there.
                waitNote = `wait did not complete (${err instanceof Error ? err.message : String(err)})`;
            }
            const read = await runHerdr([
                "agent",
                "read",
                target,
                "--source",
                "visible",
                "--lines",
                String(lines),
                "--format",
                "text",
            ]);
            return ok(`# Handoff to "${target}" — ${waitNote}\n\n${formatResult(read)}`);
        },
    },
];
//# sourceMappingURL=composite.js.map