const RECEIPT_TOKEN = /^herdr-receipt-v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/**
 * A receipt token is an opaque, non-secret lookup key. The authoritative
 * target identity and cursor remain in the mode-0600 receipt store.
 */
export function encodeHandoffReceipt(receiptId: string): string {
  const token = `herdr-receipt-v1.${receiptId}`;
  if (!RECEIPT_TOKEN.test(token)) throw new Error("invalid handoff receipt id");
  return token;
}

export function decodeHandoffReceipt(token: string): string {
  const match = RECEIPT_TOKEN.exec(token);
  if (!match) throw new Error("invalid handoff receipt token");
  return match[1].toLowerCase();
}
