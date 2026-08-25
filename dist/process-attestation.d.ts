export interface ProcessIdentity {
    pid: number;
    bootId: string;
    startTicks: string;
}
interface ProcessSnapshot extends ProcessIdentity {
    parentPid: number;
}
export declare function readProcessSnapshot(pid: number): Promise<ProcessSnapshot>;
export declare function readProcessIdentity(pid: number): Promise<ProcessIdentity>;
export declare function processDescendsFrom(callerPid: number, expected: ProcessIdentity, readSnapshot?: (pid: number) => Promise<ProcessSnapshot>): Promise<boolean>;
export {};
