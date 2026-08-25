/**
 * A receipt token is an opaque, non-secret lookup key. The authoritative
 * target identity and cursor remain in the mode-0600 receipt store.
 */
export declare function encodeHandoffReceipt(receiptId: string): string;
export declare function decodeHandoffReceipt(token: string): string;
