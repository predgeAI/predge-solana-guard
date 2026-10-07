// Turn a signed record from api.predge.io into on-chain attestations.
//
// GET https://api.predge.io/v1/settlement-risk/<polymarket market id> returns
// a settlement-risk record plus `attestation`: an ed25519 signature by
// Predge's published attestation key over `canonical` (JSON, keys sorted at
// every level, no whitespace). This module:
//   1. re-canonicalises `payload` and checks it equals `canonical`;
//   2. verifies the signature against the pinned Predge key;
//   3. maps the signed facts to the 97-byte attestations the Solana program
//      accepts, with evidence_hash = sha256(canonical), so every on-chain
//      record points at exactly one API-signed record.
import nacl from "tweetnacl";
import { Attestation, OPEN_DISPUTE_RISK_BPS, Status, polymarketKey, sha256, toUnix } from "./lib";

/**
 * Predge's published attestation key (role "attestation" in
 * https://api.predge.io/.well-known/predge-keys.json). Pinned in source on
 * purpose: whoever can change an env var should not be able to swap the
 * trusted signer.
 */
export const PREDGE_API_KEY_HEX = "13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9";

export interface ApiDispute {
  disputed_at: string;
  tx: string;
  disputed_proposal: string | null;
}

export interface ApiPayload {
  version: string;
  issuer: string;
  kind: string;
  platform: string;
  chain: string;
  market_id: string;
  uma_question_id: string;
  uma_state: string;
  resolved_on_chain: boolean;
  dispute_count: string;
  open_dispute: boolean;
  sent_to_uma_vote: boolean;
  current_proposal: unknown;
  disputes: ApiDispute[];
  onchain_resolution: { outcome: string } | null;
  checked_at: string;
  issued_at: string;
  [k: string]: unknown;
}

export interface ApiRecord {
  market: { market_id: string; question: string; slug?: string };
  attestation: {
    version: string;
    algorithm: string;
    public_key: string;
    canonical: string;
    signature: string;
    payload: ApiPayload;
  };
  [k: string]: unknown;
}

/** JSON with keys sorted at every level and no insignificant whitespace. */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
    .join(",")}}`;
}

export interface VerifiedRecord {
  payload: ApiPayload;
  canonical: Buffer;
  evidenceHash: Buffer;
  title: string;
}

/** Throws unless the record is signed by `trustedKeyHex` over its own payload. */
export function verifyApiRecord(rec: ApiRecord, trustedKeyHex = PREDGE_API_KEY_HEX): VerifiedRecord {
  const a = rec.attestation;
  if (!a) throw new Error("record has no attestation");
  if (a.algorithm !== "ed25519") throw new Error(`unsupported algorithm ${a.algorithm}`);
  if (a.public_key.toLowerCase() !== trustedKeyHex.toLowerCase()) {
    throw new Error(`record signed by ${a.public_key}, expected pinned Predge key ${trustedKeyHex}`);
  }
  if (canonicalize(a.payload) !== a.canonical) throw new Error("payload does not re-canonicalise to `canonical`");
  const canonical = Buffer.from(a.canonical, "utf8");
  const ok = nacl.sign.detached.verify(canonical, Buffer.from(a.signature, "hex"), Buffer.from(a.public_key, "hex"));
  if (!ok) throw new Error("ed25519 signature does not verify");
  return { payload: a.payload, canonical, evidenceHash: sha256(canonical), title: rec.market?.question ?? a.payload.market_id };
}

/** Current state of the market, as signed at `checked_at`. */
export function currentAttestation(v: VerifiedRecord, opts: { marketKey?: Buffer; settledAt?: number } = {}): Attestation {
  const p = v.payload;
  const disputes = Number(p.dispute_count);
  const lastDisputed = p.disputes.length ? p.disputes[p.disputes.length - 1].disputed_proposal : null;
  const base = {
    marketKey: opts.marketKey ?? polymarketKey(p.uma_question_id),
    disputeCount: Math.min(disputes, 255),
    observedAt: toUnix(p.checked_at),
    evidenceHash: v.evidenceHash,
  };
  if (p.resolved_on_chain) {
    const outcome = p.onchain_resolution?.outcome ?? null;
    return {
      ...base,
      status: Status.SETTLED,
      settledDifferently: lastDisputed !== null && outcome !== null && lastDisputed !== outcome ? 1 : 0,
      riskBps: 0,
      // The API record does not carry the resolution time. Callers pass the
      // on-chain resolution time when they have it; otherwise checked_at is
      // used, which is never earlier than the real resolution.
      settledAt: opts.settledAt ?? toUnix(p.checked_at),
    };
  }
  if (p.open_dispute) {
    const escalated = p.sent_to_uma_vote || disputes >= 2;
    return { ...base, status: escalated ? Status.ESCALATED : Status.DISPUTED, settledDifferently: 0, riskBps: OPEN_DISPUTE_RISK_BPS, settledAt: 0 };
  }
  if (p.current_proposal) {
    return { ...base, status: Status.PROPOSED, settledDifferently: 0, riskBps: 0, settledAt: 0 };
  }
  throw new Error(`market ${p.market_id} has no proposal, dispute or resolution to attest (uma_state=${p.uma_state})`);
}

/**
 * The resolution path contained in the signed record: one attestation per
 * dispute (dated at the dispute), then the current state. Used to replay how
 * the gate behaved while the market was disputed.
 */
export function timelineAttestations(v: VerifiedRecord, opts: { marketKey?: Buffer; settledAt?: number } = {}): Attestation[] {
  const marketKey = opts.marketKey ?? polymarketKey(v.payload.uma_question_id);
  const out: Attestation[] = v.payload.disputes.map((d, i) => ({
    marketKey,
    status: i === 0 ? Status.DISPUTED : Status.ESCALATED,
    disputeCount: i + 1,
    settledDifferently: 0,
    riskBps: OPEN_DISPUTE_RISK_BPS,
    settledAt: 0,
    observedAt: toUnix(d.disputed_at),
    evidenceHash: v.evidenceHash,
  }));
  out.push(currentAttestation(v, { marketKey, settledAt: opts.settledAt }));
  return out;
}
