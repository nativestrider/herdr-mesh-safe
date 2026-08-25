import { type ToolDef } from "./types.js";
export declare function buildRelayArgs(target: string, text: string): string[];
export declare function buildHandoffPromptArgs(target: string, message: string, status: string | undefined, timeout: number): string[];
export declare const compositeTools: ToolDef[];
