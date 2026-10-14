// The 97-byte attestation the guard verifies. Layout must match
// `Attestation::message()` in programs/predge_guard/src/lib.rs:
//
//   offset size field
//   0      12   "PREDGE-SR-v1"
//   12     32   market_key
//   44     1    status
//   45     1    dispute_count
//   46     1    settled_differently (0/1)
//   47     2    risk_bps (u16 LE)
//   49     8    settled_at (i64 LE)
//   57     8    observed_at (i64 LE)
//   65     32   evidence_hash
//
// Bytes 12..97 are also the Borsh encoding of the `Attestation` struct, i.e.
// the argument of `post_attestation`.
import { ed25519 } from "@noble/curves/ed25519";
import { ATTESTATION_DOMAIN, ATTESTATION_MESSAGE_LEN, MAX_CLOCK_DRIFT_SECS, Status } from "./constants.js";
import { bytesEqual, expectLength, sha256 } from "./bytes.js";

export interface Attestation {
  /** 32 bytes: sha256("polymarket:" + UMA question id, lowercase 0x hex). */
  marketKey: Uint8Array;
  status: number;
  disputeCount: number;
  /** 1 if the settled outcome differs from the last disputed proposal. */
  settledDifferently: number;
  riskBps: number;
  /** Unix seconds; 0 unless settled. */
  settledAt: number;
  /** Unix seconds. */
  observedAt: number;
  /** 32 bytes: sha256 of the signed off-chain record. */
  evidenceHash: Uint8Array;
}

export interface SignedAttestation {
  attestation: Attestation;
  /** The 97 signed bytes. */
  message: Uint8Array;
  /** 64-byte ed25519 signature over `message`. */
  signature: Uint8Array;
  /** 32-byte ed25519 public key of the attestor. */
  attestor: Uint8Array;
}

/** Market key for a Polymarket question: sha256("polymarket:" + questionId.toLowerCase()). */
export function polymarketMarketKey(umaQuestionId: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(umaQuestionId)) {
    throw new Error(`UMA question id must be 0x followed by 64 hex chars, got ${umaQuestionId}`);
  }
  return sha256(`polymarket:${umaQuestionId.toLowerCase()}`);
}

function checkInt(v: number, min: number, max: number, what: string): void {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`${what} out of range: ${v}`);
}

const I64_MIN = -(2 ** 53 - 1);
const I64_MAX = 2 ** 53 - 1;

/** Encode the exact bytes the attestor signs. Throws if a field does not fit its type. */
export function encodeAttestationMessage(a: Attestation): Uint8Array {
  expectLength(a.marketKey, 32, "marketKey");
  expectLength(a.evidenceHash, 32, "evidenceHash");
  checkInt(a.status, 0, 255, "status");
  checkInt(a.disputeCount, 0, 255, "disputeCount");
  checkInt(a.settledDifferently, 0, 255, "settledDifferently");
  checkInt(a.riskBps, 0, 0xffff, "riskBps");
  checkInt(a.settledAt, I64_MIN, I64_MAX, "settledAt");
  checkInt(a.observedAt, I64_MIN, I64_MAX, "observedAt");

  const m = new Uint8Array(ATTESTATION_MESSAGE_LEN);
  const dv = new DataView(m.buffer);
  m.set(ATTESTATION_DOMAIN, 0);
  m.set(a.marketKey, 12);
  m[44] = a.status;
  m[45] = a.disputeCount;
  m[46] = a.settledDifferently;
  dv.setUint16(47, a.riskBps, true);
  dv.setBigInt64(49, BigInt(a.settledAt), true);
  dv.setBigInt64(57, BigInt(a.observedAt), true);
  m.set(a.evidenceHash, 65);
  return m;
}

/** Decode a 97-byte attestation message. Throws on a wrong length or domain. */
export function decodeAttestationMessage(m: Uint8Array): Attestation {
  expectLength(m, ATTESTATION_MESSAGE_LEN, "attestation message");
  if (!bytesEqual(m.subarray(0, 12), ATTESTATION_DOMAIN)) throw new Error("attestation message has the wrong domain separator");
  const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
  return {
    marketKey: m.slice(12, 44),
    status: m[44],
    disputeCount: m[45],
    settledDifferently: m[46],
    riskBps: dv.getUint16(47, true),
    settledAt: Number(dv.getBigInt64(49, true)),
    observedAt: Number(dv.getBigInt64(57, true)),
    evidenceHash: m.slice(65, 97),
  };
}

/** Borsh encoding of `Attestation` (the `post_attestation` argument): message bytes 12..97. */
export function encodeAttestationArg(a: Attestation): Uint8Array {
  return encodeAttestationMessage(a).slice(12);
}

/**
 * The checks `post_attestation` applies to the fields before it verifies the
 * signature. Returns a list of problems (empty if the program would accept the
 * fields). `nowUnix` enables the future-date check.
 */
export function attestationProblems(a: Attestation, nowUnix?: number): string[] {
  const p: string[] = [];
  if (!(a.status >= Status.PROPOSED && a.status <= Status.SETTLED)) p.push(`InvalidStatus: status ${a.status} not in 1..4`);
  if (a.riskBps > 10_000) p.push(`InvalidRisk: riskBps ${a.riskBps} > 10000`);
  if (a.settledDifferently > 1) p.push(`InvalidStatus: settledDifferently ${a.settledDifferently} not 0/1`);
  if (a.status === Status.SETTLED && !(a.settledAt > 0)) p.push("InvalidStatus: settled attestation needs settledAt > 0");
  if (nowUnix !== undefined && a.observedAt > nowUnix + MAX_CLOCK_DRIFT_SECS) {
    p.push(`FutureAttestation: observedAt ${a.observedAt} is more than ${MAX_CLOCK_DRIFT_SECS}s ahead of ${nowUnix}`);
  }
  return p;
}

/**
 * Sign an attestation with an ed25519 key. Accepts a 32-byte seed or a
 * 64-byte secret key (seed || public key, as in Solana keypair files).
 * Only the configured attestor's signature is accepted on-chain.
 */
export function signAttestation(a: Attestation, secretKey: Uint8Array): SignedAttestation {
  if (secretKey.length !== 32 && secretKey.length !== 64) throw new Error("secretKey must be 32 or 64 bytes");
  const seed = secretKey.subarray(0, 32);
  const attestor = ed25519.getPublicKey(seed);
  if (secretKey.length === 64 && !bytesEqual(attestor, secretKey.subarray(32, 64))) {
    throw new Error("secretKey: public half does not match the seed");
  }
  const message = encodeAttestationMessage(a);
  const signature = ed25519.sign(message, seed);
  return { attestation: a, message, signature, attestor };
}

/** True if `signature` is a valid ed25519 signature by `attestor` over the encoded attestation. */
export function verifyAttestationSignature(a: Attestation, signature: Uint8Array, attestor: Uint8Array): boolean {
  if (signature.length !== 64 || attestor.length !== 32) return false;
  try {
    return ed25519.verify(signature, encodeAttestationMessage(a), attestor, { zip215: false });
  } catch {
    return false;
  }
}
