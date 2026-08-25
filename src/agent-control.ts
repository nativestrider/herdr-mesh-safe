#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { compositeTools } from "./tools/composite.js";
import { currentCallerControllerAuthority } from "./tools/safe-controller.js";
import { safePaneLeaseTools } from "./tools/safe-pane-lease.js";
import { execTool, type ToolDef, type ToolResult } from "./tools/types.js";

type Mode = "all" | "first";

interface CommonOptions {
  mode: Mode;
  timeoutMs: number;
  readLines: number;
}

export function usage(): string {
  return `Usage:
  herdr-agent-control status
  herdr-agent-control receipts
  herdr-agent-control ask TARGET [--timeout-ms N] [--read-lines N] -- MESSAGE
  herdr-agent-control ask-many --request TARGET=MESSAGE [--request TARGET=MESSAGE ...]
                         [--mode all|first] [--timeout-ms N] [--read-lines N]
  herdr-agent-control collect --receipt TOKEN [--receipt TOKEN ...]
                        [--mode all|first] [--timeout-ms N] [--read-lines N]
  herdr-agent-control abandon --receipt TOKEN

The command must run from the active named coordinator pane. It reuses the
current bridge controller fence and lease reservations without printing them.`;
}

function positiveInteger(value: string | undefined, option: string, maximum: number): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error(`${option} requires a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${option} must be at most ${maximum}`);
  }
  return parsed;
}

function targetArgument(value: string | undefined): string {
  if (!value || value.startsWith("-") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("target is missing or invalid");
  }
  return value;
}

function parseCommon(argv: string[], allowMode = true): { rest: string[]; options: CommonOptions } {
  const rest: string[] = [];
  const options: CommonOptions = { mode: "all", timeoutMs: 120_000, readLines: 200 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mode") {
      if (!allowMode) throw new Error("--mode is not supported by this command");
      const mode = argv[++index];
      if (mode !== "all" && mode !== "first") throw new Error("--mode must be all or first");
      options.mode = mode;
    } else if (value === "--timeout-ms") {
      options.timeoutMs = positiveInteger(argv[++index], "--timeout-ms", 600_000);
    } else if (value === "--read-lines") {
      options.readLines = positiveInteger(argv[++index], "--read-lines", 2_000);
    } else {
      rest.push(value);
    }
  }
  return { rest, options };
}

function tool(name: string, definitions: ToolDef[]): ToolDef {
  const selected = definitions.find((candidate) => candidate.name === name);
  if (!selected) throw new Error(`bridge tool is unavailable: ${name}`);
  return selected;
}

interface AgentControlDependencies {
  resolveAuthority: typeof currentCallerControllerAuthority;
  compositeDefinitions: ToolDef[];
  paneLeaseDefinitions: ToolDef[];
  write: (text: string) => void;
  environment: NodeJS.ProcessEnv;
}

const defaultDependencies: AgentControlDependencies = {
  resolveAuthority: currentCallerControllerAuthority,
  compositeDefinitions: compositeTools,
  paneLeaseDefinitions: safePaneLeaseTools,
  write: (text) => process.stdout.write(text),
  environment: process.env,
};

function printResult(result: ToolResult, write: (text: string) => void): void {
  const message = result.content.map((item) => item.text).join("\n");
  if (result.isError) throw new Error(message);
  write(`${message}\n`);
}

export function requireManagedCaller(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.HERDR_ENV !== "1" || !environment.HERDR_PANE_ID) {
    throw new Error("agent-control must run from a Herdr-managed coordinator pane");
  }
  const controllerId = environment.AGENT_CONTROL_CONTROLLER_ID;
  if (!controllerId || !/^[A-Za-z0-9_.-]{1,100}$/.test(controllerId)) {
    throw new Error("AGENT_CONTROL_CONTROLLER_ID is missing or invalid");
  }
  return controllerId;
}

async function credentials(controllerId: string, dependencies: AgentControlDependencies) {
  const lease = await dependencies.resolveAuthority(controllerId);
  return {
    controller_id: controllerId,
    controller_lease_id: lease.leaseId,
    controller_fence_token: lease.fenceToken,
  };
}

export async function main(
  argv = process.argv.slice(2),
  dependencies: AgentControlDependencies = defaultDependencies,
): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    dependencies.write(`${usage()}\n`);
    return;
  }
  const controllerId = requireManagedCaller(dependencies.environment);
  const command = argv.shift();

  if (command === "status") {
    if (argv.length > 0) throw new Error("status accepts no arguments");
    printResult(await execTool(tool("herdr_lease_inventory", dependencies.paneLeaseDefinitions), {
      controller_id: controllerId,
    }), dependencies.write);
    return;
  }

  if (command === "receipts") {
    if (argv.length > 0) throw new Error("receipts accepts no arguments");
    printResult(await execTool(tool("herdr_handoff_receipt_list", dependencies.compositeDefinitions), {
      controller_id: controllerId,
    }), dependencies.write);
    return;
  }

  const authority = await credentials(controllerId, dependencies);

  if (command === "ask") {
    const separator = argv.indexOf("--");
    if (separator < 1) throw new Error("ask requires TARGET -- MESSAGE");
    const target = targetArgument(argv[0]);
    const { rest, options } = parseCommon(argv.slice(1, separator), false);
    if (rest.length > 0) throw new Error(`unknown ask arguments: ${rest.join(" ")}`);
    const message = argv.slice(separator + 1).join(" ").trim();
    if (!message) throw new Error("ask message is empty");
    printResult(await execTool(tool("herdr_batch_handoff", dependencies.compositeDefinitions), {
      ...authority,
      requests: [{ target, message }],
      mode: "all",
      timeout_ms: options.timeoutMs,
      read_lines: options.readLines,
    }), dependencies.write);
    return;
  }

  if (command === "ask-many") {
    const requests: Array<{ target: string; message: string }> = [];
    const common: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] !== "--request") {
        common.push(argv[index]);
        continue;
      }
      const encoded = argv[++index] ?? "";
      const separator = encoded.indexOf("=");
      if (separator < 1 || !encoded.slice(separator + 1).trim()) {
        throw new Error("--request must be TARGET=MESSAGE");
      }
      requests.push({
        target: targetArgument(encoded.slice(0, separator)),
        message: encoded.slice(separator + 1),
      });
    }
    const { rest, options } = parseCommon(common);
    if (rest.length > 0) throw new Error(`unknown ask-many arguments: ${rest.join(" ")}`);
    if (requests.length < 1 || requests.length > 8) {
      throw new Error("ask-many requires between one and eight --request values");
    }
    printResult(await execTool(tool("herdr_batch_handoff", dependencies.compositeDefinitions), {
      ...authority,
      requests,
      mode: options.mode,
      timeout_ms: options.timeoutMs,
      read_lines: options.readLines,
    }), dependencies.write);
    return;
  }

  if (command === "collect") {
    const receipts: string[] = [];
    const common: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] !== "--receipt") {
        common.push(argv[index]);
        continue;
      }
      const receipt = argv[++index];
      if (!receipt) throw new Error("--receipt requires a token");
      receipts.push(receipt);
    }
    const { rest, options } = parseCommon(common);
    if (rest.length > 0) throw new Error(`unknown collect arguments: ${rest.join(" ")}`);
    printResult(await execTool(tool("herdr_collect_handoffs", dependencies.compositeDefinitions), {
      ...authority,
      receipts,
      mode: options.mode,
      timeout_ms: options.timeoutMs,
      read_lines: options.readLines,
    }), dependencies.write);
    return;
  }

  if (command === "abandon") {
    if (argv.length !== 2 || argv[0] !== "--receipt" || !argv[1]) {
      throw new Error("abandon requires exactly one --receipt TOKEN");
    }
    printResult(await execTool(tool("herdr_handoff_receipt_abandon", dependencies.compositeDefinitions), {
      ...authority,
      receipt: argv[1],
    }), dependencies.write);
    return;
  }

  throw new Error(`unknown command: ${String(command)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`agent-control: ${message}\n`);
    process.exitCode = 1;
  });
}
