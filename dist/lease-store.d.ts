export type ReservationLockState = "absent" | "active" | "stale" | "indeterminate";
export interface ReservationLockStatus {
    state: ReservationLockState;
    reason: string;
}
export declare function reservationLockStatus(directory: string): Promise<ReservationLockStatus>;
export type ReviewerLeaseState = "provisioning" | "active" | "closing" | "closed" | "failed_closed" | "orphaned" | "close_failed";
export interface ReviewerLease {
    version: 1;
    leaseId: string;
    controllerId: string;
    purpose: string;
    parentPaneId: string;
    paneId: string;
    agentName: string;
    agentKind: string;
    cwd: string;
    state: ReviewerLeaseState;
    createdAt: string;
    closedAt?: string;
    captureSha256?: string;
    failure?: string;
}
export type WriterLeaseState = "provisioning" | "active" | "releasing" | "released" | "failed_closed" | "orphaned" | "release_failed";
export interface WriterLease {
    version: 1;
    leaseType: "writer";
    leaseId: string;
    controllerId: string;
    purpose: string;
    ticketRef: string;
    authorityRef: string;
    authoritySha256: string;
    parentPaneId: string;
    paneId: string;
    agentName: string;
    agentKind: string;
    repositoryRoot: string;
    gitDir: string;
    gitCommonDir: string;
    worktree: string;
    branch: string;
    baseCommit: string;
    headCommit: string;
    gitStatusSha256: string;
    ownedScopes: string[];
    lockedScopes: string[];
    protectedBranches: string[];
    state: WriterLeaseState;
    createdAt: string;
    releasedAt?: string;
    checkpointRef?: string;
    checkpointSha256?: string;
    captureSha256?: string;
    failure?: string;
}
export type AdoptedPaneLeaseState = "active" | "closing" | "closed" | "close_failed";
export interface AdoptedPaneLease {
    version: 1;
    leaseType: "adopted-pane";
    leaseId: string;
    controllerId: string;
    purpose: string;
    authorityRef: string;
    authoritySha256: string;
    paneId: string;
    agentName: string;
    agentKind: string;
    cwd: string;
    stateChangeSeq: number;
    state: AdoptedPaneLeaseState;
    adoptedAt: string;
    closedAt?: string;
    checkpointRef?: string;
    checkpointSha256?: string;
    captureSha256?: string;
    failure?: string;
}
export type ControllerLeaseState = "active" | "released";
export interface ControllerLease {
    version: 1;
    leaseType: "controller";
    leaseId: string;
    controllerId: string;
    fenceToken: string;
    generation: number;
    authorityRef: string;
    authoritySha256: string;
    paneId: string;
    agentName: string;
    agentKind: string;
    cwd: string;
    state: ControllerLeaseState;
    acquiredAt: string;
    renewedAt: string;
    expiresAt: string;
    releasedAt?: string;
    predecessorLeaseId?: string;
}
export declare class LeaseStore {
    readonly directory: string;
    constructor(stateDir?: string);
    create(lease: ReviewerLease): Promise<void>;
    update(lease: ReviewerLease): Promise<void>;
    get(leaseId: string): Promise<ReviewerLease>;
    list(controllerId?: string): Promise<ReviewerLease[]>;
    withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T>;
    private ensureDirectory;
    private pathFor;
    private assertLeaseId;
    private serialize;
    private parse;
}
export declare class WriterLeaseStore {
    readonly directory: string;
    constructor(stateDir?: string);
    create(lease: WriterLease): Promise<void>;
    update(lease: WriterLease): Promise<void>;
    get(leaseId: string): Promise<WriterLease>;
    list(controllerId?: string): Promise<WriterLease[]>;
    withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T>;
    private ensureDirectory;
    private pathFor;
    private assertLeaseId;
    private serialize;
    private parse;
}
export declare class AdoptedPaneLeaseStore {
    readonly directory: string;
    constructor(stateDir?: string);
    create(lease: AdoptedPaneLease): Promise<void>;
    update(lease: AdoptedPaneLease): Promise<void>;
    get(leaseId: string): Promise<AdoptedPaneLease>;
    list(controllerId?: string): Promise<AdoptedPaneLease[]>;
    withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T>;
    private ensureDirectory;
    private pathFor;
    private assertLeaseId;
    private serialize;
    private parse;
}
export declare class ControllerLeaseStore {
    readonly directory: string;
    constructor(stateDir?: string);
    get(controllerId: string): Promise<ControllerLease>;
    getOptional(controllerId: string): Promise<ControllerLease | undefined>;
    list(): Promise<ControllerLease[]>;
    create(lease: ControllerLease): Promise<void>;
    replace(lease: ControllerLease, expectedCurrentLeaseId: string): Promise<void>;
    assertActive(controllerId: string, leaseId: string, fenceToken: string, now: Date): Promise<ControllerLease>;
    withExclusiveReservation<T>(operation: () => Promise<T>): Promise<T>;
    private ensureDirectory;
    private pathFor;
    private write;
    private assertControllerId;
    private assertRecord;
    private serialize;
    private parse;
}
