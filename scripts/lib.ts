// Shared helpers: build, sign and package Predge settlement-risk attestations.
// The byte layout here must match `Attestation::message()` in
// programs/predge_guard/src/lib.rs.
import { createHash } from "crypto";
import nacl from "tweetnacl";
import { Ed25519Program, PublicKey, TransactionInstruction } from "@solana/web3.js";

export const DOMAIN = Buffer.from("PREDGE-SR-v1", "ascii");
export const MESSAGE_LEN = 97;

export const Status = {
  UNKNOWN: 0,
  PROPOSED: 1,
  DISPUTED: 2,
  ESCALATED: 3,
  SETTLED: 4,
} as const;
export const STATUS_NAME: Record<number, string> = {
  0: "UNKNOWN",
  1: "PROPOSED",
  2: "DISPUTED",
  3: "ESCALATED (UMA vote)",
  4: "SETTLED",
};

/**
 * Base rate used for open disputes, from Predge's 2026 scan of Polymarket on
 * Polygon (1 Jan to 2 Oct 2026): of 2,543 settled disputed markets, 853
 * (33.5%) settled differently from the disputed proposal. 853 / 2543 = 0.3354.
 */
export const OPEN_DISPUTE_RISK_BPS = 3354;

export interface Attestation {
  marketKey: Buffer; // 32 bytes
  status: number;
  disputeCount: number;
  settledDifferently: number; // 0 or 1
  riskBps: number;
  settledAt: number; // unix seconds, 0 if not settled
  observedAt: number; // unix seconds
  evidenceHash: Buffer; // 32 bytes
}

export function sha256(data: string | Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/** Market key for a Polymarket question: sha256("polymarket:" + questionID). */
export function polymarketKey(questionId: string): Buffer {
  return sha256(`polymarket:${questionId.toLowerCase()}`);
}

export function encodeMessage(a: Attestation): Buffer {
  if (a.marketKey.length !== 32 || a.evidenceHash.length !== 32) {
    throw new Error("marketKey and evidenceHash must be 32 bytes");
  }
  const m = Buffer.alloc(MESSAGE_LEN);
  DOMAIN.copy(m, 0);
  a.marketKey.copy(m, 12);
  m.writeUInt8(a.status, 44);
  m.writeUInt8(a.disputeCount, 45);
  m.writeUInt8(a.settledDifferently, 46);
  m.writeUInt16LE(a.riskBps, 47);
  m.writeBigInt64LE(BigInt(a.settledAt), 49);
  m.writeBigInt64LE(BigInt(a.observedAt), 57);
  a.evidenceHash.copy(m, 65);
  return m;
}

export interface SignedAttestation {
  attestation: Attestation;
  message: Buffer;
  signature: Buffer;
  publicKey: Buffer;
}

export function signAttestation(a: Attestation, secretKey: Uint8Array): SignedAttestation {
  const message = encodeMessage(a);
  const signature = Buffer.from(nacl.sign.detached(message, secretKey));
  const publicKey = Buffer.from(secretKey.slice(32, 64));
  return { attestation: a, message, signature, publicKey };
}

export function verifyAttestation(s: SignedAttestation): boolean {
  return nacl.sign.detached.verify(encodeMessage(s.attestation), s.signature, s.publicKey);
}

/** Native Ed25519 program instruction that must precede `post_attestation`. */
export function ed25519Ix(s: SignedAttestation): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: s.publicKey,
    message: s.message,
    signature: s.signature,
  });
}

/** Anchor argument shape for `post_attestation`. */
export function toAnchorArg(a: Attestation) {
  // BN is imported lazily so that this file also works in plain Node scripts.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BN } = require("@coral-xyz/anchor");
  return {
    marketKey: Array.from(a.marketKey),
    status: a.status,
    disputeCount: a.disputeCount,
    settledDifferently: a.settledDifferently,
    riskBps: a.riskBps,
    settledAt: new BN(a.settledAt),
    observedAt: new BN(a.observedAt),
    evidenceHash: Array.from(a.evidenceHash),
  };
}

/** Record shape in data/polymarket-disputes-2026.json. */
export interface DisputeRecord {
  question_id: string;
  market_id: string | null;
  title: string | null;
  adapter: string;
  n_disputes: number;
  first_dispute_utc: string;
  dispute_txs: string[];
  last_disputed_price: string;
  resolved_utc: string | null;
  settled_price: string | null;
}

const toUnix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/**
 * Map one observed market to an attestation, as of `observedAt`.
 * Rules (v0, transparent on purpose):
 *  - resolved on Polygon            -> SETTLED, risk 0
 *  - disputed twice or more, open   -> ESCALATED, risk = 2026 base rate
 *  - disputed once, open            -> DISPUTED,  risk = 2026 base rate
 */
export function attestationFromRecord(
  r: DisputeRecord,
  observedAt: number,
  evidenceHash: Buffer
): Attestation {
  const settled = !!r.resolved_utc;
  const status = settled
    ? Status.SETTLED
    : r.n_disputes >= 2
    ? Status.ESCALATED
    : Status.DISPUTED;
  return {
    marketKey: polymarketKey(r.question_id),
    status,
    disputeCount: Math.min(r.n_disputes, 255),
    settledDifferently: settled && r.settled_price !== r.last_disputed_price ? 1 : 0,
    riskBps: settled ? 0 : OPEN_DISPUTE_RISK_BPS,
    settledAt: settled ? toUnix(r.resolved_utc!) : 0,
    observedAt,
    evidenceHash,
  };
}

/** Evidence hash for a dataset record when no full evidence pack exists yet. */
export function recordEvidenceHash(r: DisputeRecord): Buffer {
  const canonical = JSON.stringify(r, Object.keys(r).sort());
  return sha256(canonical);
}

export function pda(programId: PublicKey, ...seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), programId)[0];
}

export { toUnix };
