// Guard error codes, from `GuardError` in lib.rs (Anchor numbers them from 6000).
export const GUARD_ERRORS = {
  6000: { name: "InvalidConfig", msg: "Invalid config" },
  6001: { name: "InvalidStatus", msg: "Invalid status" },
  6002: { name: "InvalidRisk", msg: "risk_bps must be at most 10000" },
  6003: { name: "FutureAttestation", msg: "Attestation is dated in the future" },
  6004: { name: "StaleAttestation", msg: "Attestation is not newer than the stored one" },
  6005: { name: "AlreadySettled", msg: "Market already settled; only a settled restatement is accepted" },
  6006: { name: "MissingEd25519Ix", msg: "Expected an Ed25519 signature instruction right before this one" },
  6007: { name: "BadEd25519Ix", msg: "Malformed Ed25519 instruction" },
  6008: { name: "WrongAttestor", msg: "Signature is not from the configured attestor" },
  6009: { name: "MessageMismatch", msg: "Signed message does not match the attestation" },
  6010: { name: "SettlementNotFinal", msg: "Reference market is not settled yet" },
  6011: { name: "MarketDisputed", msg: "Reference market is disputed" },
  6012: { name: "MarketEscalated", msg: "Reference market is escalated to a UMA vote" },
  6013: { name: "CoolingPeriod", msg: "Reference market settled but the cooling window has not passed" },
  6014: { name: "InvalidAmount", msg: "Amount must be positive" },
} as const;

export type GuardErrorCode = keyof typeof GUARD_ERRORS;
export type GuardErrorName = (typeof GUARD_ERRORS)[GuardErrorCode]["name"];

const BY_NAME = new Map<string, number>(Object.entries(GUARD_ERRORS).map(([c, e]) => [e.name, Number(c)]));

/**
 * Find a guard error in transaction logs or in an error thrown by web3.js /
 * Anchor. Returns null if none is present. A consumer error whose name is
 * not a guard error name (for example `WrongMarket`) is not matched.
 */
export function parseGuardError(input: unknown): { code: number; name: GuardErrorName } | null {
  // Anchor logs "Error Code: <Name>. Error Number: <n>". The bare
  // "custom program error: 0x..." form is not used: consumer programs built
  // with Anchor also number their errors from 6000.
  const text = collectText(input);
  for (const m of text.matchAll(/Error Code: (\w+)\. Error Number: (\d+)/g)) {
    if (BY_NAME.get(m[1]) === Number(m[2])) return { code: Number(m[2]), name: m[1] as GuardErrorName };
  }
  return null;
}

function collectText(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.map(collectText).join("\n");
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    return [o.message, o.logs, o.transactionLogs, o.transactionMessage].map(collectText).join("\n");
  }
  return String(input);
}
