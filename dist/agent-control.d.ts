#!/usr/bin/env node
import { currentCallerControllerAuthority } from "./tools/safe-controller.js";
import { type ToolDef } from "./tools/types.js";
export declare function usage(): string;
interface AgentControlDependencies {
    resolveAuthority: typeof currentCallerControllerAuthority;
    compositeDefinitions: ToolDef[];
    paneLeaseDefinitions: ToolDef[];
    write: (text: string) => void;
    environment: NodeJS.ProcessEnv;
}
export declare function requireManagedCaller(environment?: NodeJS.ProcessEnv): string;
export declare function main(argv?: string[], dependencies?: AgentControlDependencies): Promise<void>;
export {};
