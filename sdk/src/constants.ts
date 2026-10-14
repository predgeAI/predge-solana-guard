import { PublicKey } from "@solana/web3.js";

/** Predge Settlement Guard program (same ID on devnet and localnet). */
export const PREDGE_GUARD_PROGRAM_ID = new PublicKey("B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush");
/** Example consumer vault that CPIs into `check_settlement`. */
export const EXAMPLE_CONSUMER_PROGRAM_ID = new PublicKey("6HSBJp8n4wM3RdjbbJY5XoKkBAH16HL8hEPbgk1RwUpg");

/** Default Predge API base URL. */
export const PREDGE_API_BASE = "https://api.predge.io";

/**
 * Predge's published attestation key (role "attestation", kid 13fa3d18a369e6c7)
 * in https://api.predge.io/.well-known/predge-keys.json. Pinned in source so
 * that a compromised network path or config cannot swap the trusted signer.
 * Same value as `PREDGE_API_KEY_HEX` in scripts/api-record.ts.
 */
export const PREDGE_ATTESTATION_KEY_HEX = "13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9";

/** Domain separator that prefixes every signed attestation (`DOMAIN` in lib.rs). */
export const ATTESTATION_DOMAIN = new TextEncoder().encode("PREDGE-SR-v1");
/** Length of the signed attestation message (`MESSAGE_LEN` in lib.rs). */
export const ATTESTATION_MESSAGE_LEN = 97;
/** `post_attestation` rejects attestations dated further ahead than this (`MAX_CLOCK_DRIFT_SECS`). */
export const MAX_CLOCK_DRIFT_SECS = 300;

/** PDA seeds. */
export const CONFIG_SEED = new TextEncoder().encode("config");
export const MARKET_RISK_SEED = new TextEncoder().encode("risk");

/** Market status values (`status` module in lib.rs). */
export const Status = {
  UNKNOWN: 0,
  /** An outcome was proposed to the oracle and is in its challenge window. */
  PROPOSED: 1,
  /** The proposal was disputed once. */
  DISPUTED: 2,
  /** Disputed twice or more: the outcome goes to a UMA token-holder vote. */
  ESCALATED: 3,
  /** Resolved on-chain on the reference venue. */
  SETTLED: 4,
} as const;
export type StatusValue = (typeof Status)[keyof typeof Status];

export const STATUS_NAME: Record<number, string> = {
  0: "UNKNOWN",
  1: "PROPOSED",
  2: "DISPUTED",
  3: "ESCALATED",
  4: "SETTLED",
};

/**
 * Risk score used for open disputes in v0: of 2,543 settled disputed
 * Polymarket markets in 2026, 853 settled differently from the disputed
 * proposal. round(853 / 2543 * 10000) = 3354.
 */
export const OPEN_DISPUTE_RISK_BPS = 3354;

/** Anchor discriminators, from target/idl/predge_guard.json. */
export const DISCRIMINATORS = {
  postAttestation: Uint8Array.from([12, 75, 255, 83, 59, 171, 141, 27]),
  checkSettlement: Uint8Array.from([9, 104, 65, 157, 132, 211, 255, 7]),
  configAccount: Uint8Array.from([155, 12, 170, 224, 30, 250, 204, 130]),
  marketRiskAccount: Uint8Array.from([239, 210, 123, 246, 232, 219, 139, 238]),
} as const;
