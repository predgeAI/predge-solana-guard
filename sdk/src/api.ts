// Signed settlement-risk records from api.predge.io.
//
// GET /v1/settlement-risk/<polymarket market id> returns a record whose
// `attestation` holds:
//   canonical           JSON of `payload`, keys sorted at every level, no whitespace
//   signature           ed25519 by `public_key` over the UTF-8 bytes of `canonical`
//   content_hash        sha256(canonical), hex
//   envelope_signature  ed25519 over the canonical form of `attestation` minus this field
//
// The verifier below is offline: it needs the record and a trusted key, no
// network. Port of scripts/api-record.ts (same canonicalisation and the same
// mapping to on-chain attestations), plus the content_hash and envelope checks.
import { ed25519 } from "@noble/curves/ed25519";
import { Attestation, polymarketMarketKey } from "./attestation.js";
import { OPEN_DISPUTE_RISK_BPS, PREDGE_API_BASE, PREDGE_ATTESTATION_KEY_HEX, Status } from "./constants.js";
import { bytesEqual, fromHex, sha256, toHex } from "./bytes.js";

export interface ApiDispute {
  disputed_at: string;
  tx: string;
  disputed_proposal: string | null;
}

export interface SettlementRiskPayload {
  version: string;
  issuer: string;
  kind: string;
  platform: string;
  chain: string;
  market_id: string;
  uma_question_id: string;
  uma_state: string;
  resolved_on_chain: boolean;
  /** Decimal string in signed payloads. */
  dispute_count: string | number;
  open_dispute: boolean;
  sent_to_uma_vote: boolean;
  current_proposal: unknown;
  disputes: ApiDispute[];
  onchain_resolution: { outcome: string } | null;
  checked_at: string;
  issued_at: string;
  [k: string]: unknown;
}

export interface ApiAttestationEnvelope {
  version: string;
  algorithm: string;
  public_key: string;
  canonical: string;
  signature: string;
  payload: SettlementRiskPayload;
  kid?: string;
  content_hash?: string;
  envelope_signature?: string;
  [k: string]: unknown;
}

export interface SettlementRiskRecord {
  market: { market_id: string; question: string; slug?: string; uma_question_id?: string; [k: string]: unknown };
  attestation: ApiAttestationEnvelope;
  [k: string]: unknown;
}

/** JSON with keys sorted at every level and no insignificant whitespace (same rule as the API). */
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

type FetchFn = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface FetchOptions {
  /** Default https://api.predge.io */
  apiBase?: string;
  /** Custom fetch (defaults to globalThis.fetch). */
  fetch?: FetchFn;
  signal?: AbortSignal;
}

async function getJson(url: string, opts: FetchOptions): Promise<unknown> {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchFn | undefined);
  if (!f) throw new Error("no fetch available; pass opts.fetch");
  const res = await f(url, { signal: opts.signal, headers: { accept: "application/json" } });
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`GET ${url} returned HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  return res.json();
}

/** Fetch the signed settlement-risk record for a Polymarket market id. Does not verify it. */
export async function fetchSettlementRisk(marketId: string | number, opts: FetchOptions = {}): Promise<SettlementRiskRecord> {
  const base = (opts.apiBase ?? PREDGE_API_BASE).replace(/\/+$/, "");
  const rec = (await getJson(`${base}/v1/settlement-risk/${encodeURIComponent(String(marketId))}`, opts)) as SettlementRiskRecord;
  if (!rec || typeof rec !== "object" || !rec.attestation) throw new Error("response is not a signed settlement-risk record");
  return rec;
}

export interface PredgeKey {
  kid: string;
  algorithm: string;
  public_key: string;
  active: boolean;
  role: string;
}

export interface PredgeKeysDocument {
  issuer: string;
  version: string;
  keys: PredgeKey[];
  [k: string]: unknown;
}

/** Fetch https://api.predge.io/.well-known/predge-keys.json. */
export async function fetchPredgeKeys(opts: FetchOptions = {}): Promise<PredgeKeysDocument> {
  const base = (opts.apiBase ?? PREDGE_API_BASE).replace(/\/+$/, "");
  return (await getJson(`${base}/.well-known/predge-keys.json`, opts)) as PredgeKeysDocument;
}

/**
 * Active ed25519 keys with role "attestation" in a keys document, lowercase hex.
 * Use this to pick up an announced rotation; keep the pinned key as the default.
 */
export function attestationKeysFrom(doc: PredgeKeysDocument): string[] {
  return (doc.keys ?? [])
    .filter((k) => k.role === "attestation" && k.algorithm === "ed25519" && k.active === true)
    .map((k) => k.public_key.toLowerCase());
}

export interface VerifyOptions {
  /** Hex ed25519 keys to trust. Default: [PREDGE_ATTESTATION_KEY_HEX]. */
  trustedKeys?: string[];
  /**
   * Require `content_hash` and check it equals sha256(canonical). Default true.
   * Records saved before the API added the field (the examples/ fixtures) need `false`.
   */
  requireContentHash?: boolean;
  /** Require `envelope_signature`. It is always checked when present. Default false. */
  requireEnvelopeSignature?: boolean;
}

export interface VerifiedSettlementRecord {
  payload: SettlementRiskPayload;
  /** UTF-8 bytes of `canonical`, the signed bytes. */
  canonical: Uint8Array;
  /** sha256(canonical): the `evidence_hash` on-chain records carry. */
  evidenceHash: Uint8Array;
  /** Hex key that signed the record. */
  signer: string;
  /** Market question, when the record carries it. */
  title: string;
  contentHashChecked: boolean;
  envelopeSignatureChecked: boolean;
}

function ed25519Verify(sigHex: string, msg: Uint8Array, pkHex: string): boolean {
  try {
    const sig = fromHex(sigHex);
    const pk = fromHex(pkHex);
    if (sig.length !== 64 || pk.length !== 32) return false;
    return ed25519.verify(sig, msg, pk, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * Verify a record offline. Throws with the reason unless:
 *  - algorithm is ed25519 and `public_key` is one of the trusted keys (`kid`, if present, is its prefix);
 *  - `payload` re-canonicalises to exactly `canonical`;
 *  - sha256(canonical) == `content_hash`;
 *  - `signature` verifies over `canonical`;
 *  - `envelope_signature`, if present, verifies over the canonical envelope without it.
 */
export function verifySettlementRecord(rec: SettlementRiskRecord, opts: VerifyOptions = {}): VerifiedSettlementRecord {
  const a = rec?.attestation;
  if (!a) throw new Error("record has no attestation");
  if (a.algorithm !== "ed25519") throw new Error(`unsupported algorithm ${a.algorithm}`);
  const trusted = (opts.trustedKeys ?? [PREDGE_ATTESTATION_KEY_HEX]).map((k) => k.toLowerCase());
  const signer = String(a.public_key ?? "").toLowerCase();
  if (!trusted.includes(signer)) throw new Error(`record signed by ${a.public_key}, which is not a trusted (pinned) key`);
  if (a.kid !== undefined && !signer.startsWith(String(a.kid).toLowerCase())) throw new Error(`kid ${a.kid} does not match public_key`);
  if (typeof a.canonical !== "string") throw new Error("record has no canonical string");
  if (canonicalize(a.payload) !== a.canonical) throw new Error("payload does not re-canonicalise to `canonical`");

  const canonical = new TextEncoder().encode(a.canonical);
  const evidenceHash = sha256(canonical);
  let contentHashChecked = false;
  if (a.content_hash !== undefined) {
    if (!bytesEqual(fromHex(a.content_hash), evidenceHash)) {
      throw new Error(`content_hash ${a.content_hash} != sha256(canonical) ${toHex(evidenceHash)}`);
    }
    contentHashChecked = true;
  } else if (opts.requireContentHash !== false) {
    throw new Error("record has no content_hash (pass requireContentHash: false for older records)");
  }

  if (!ed25519Verify(a.signature, canonical, signer)) throw new Error("ed25519 signature does not verify over `canonical`");

  let envelopeSignatureChecked = false;
  if (a.envelope_signature !== undefined) {
    const { envelope_signature, ...rest } = a;
    if (!ed25519Verify(envelope_signature, new TextEncoder().encode(canonicalize(rest)), signer)) {
      throw new Error("envelope_signature does not verify");
    }
    envelopeSignatureChecked = true;
  } else if (opts.requireEnvelopeSignature) {
    throw new Error("record has no envelope_signature");
  }

  return {
    payload: a.payload,
    canonical,
    evidenceHash,
    signer,
    title: rec.market?.question ?? a.payload.market_id,
    contentHashChecked,
    envelopeSignatureChecked,
  };
}

const toUnix = (iso: string): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid timestamp ${iso}`);
  return Math.floor(t / 1000);
};

export interface MappingOptions {
  /** Override the market key (default: polymarketMarketKey(payload.uma_question_id)). */
  marketKey?: Uint8Array;
  /**
   * On-chain resolution time (unix seconds). The record does not carry it;
   * without it `checked_at` is used, which is never earlier than the real
   * resolution (so the cooling window is at least as long as configured).
   */
  settledAt?: number;
}

/** Market key for a verified record: sha256("polymarket:" + uma_question_id). */
export function marketKeyFromRecord(v: VerifiedSettlementRecord): Uint8Array {
  return polymarketMarketKey(v.payload.uma_question_id);
}

/**
 * The market's current state, as signed at `checked_at`, mapped to the
 * on-chain attestation (same rules as scripts/api-record.ts):
 *  - resolved on chain  -> SETTLED, risk 0
 *  - open dispute       -> ESCALATED if sent to a vote or disputed twice, else DISPUTED; risk 3354
 *  - proposal pending   -> PROPOSED, risk 0
 */
export function attestationFromRecord(v: VerifiedSettlementRecord, opts: MappingOptions = {}): Attestation {
  const p = v.payload;
  if (p.kind !== "settlement-risk" || p.platform !== "polymarket") {
    throw new Error(`unsupported record kind ${p.kind} / platform ${p.platform}`);
  }
  const disputes = Number(p.dispute_count);
  if (!Number.isInteger(disputes) || disputes < 0) throw new Error(`invalid dispute_count ${p.dispute_count}`);
  const lastDisputed = p.disputes.length ? p.disputes[p.disputes.length - 1].disputed_proposal : null;
  const base = {
    marketKey: opts.marketKey ?? marketKeyFromRecord(v),
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
 * The resolution path inside the signed record: one attestation per dispute
 * (dated at the dispute), then the current state. Useful for replays and tests.
 */
export function timelineFromRecord(v: VerifiedSettlementRecord, opts: MappingOptions = {}): Attestation[] {
  const marketKey = opts.marketKey ?? marketKeyFromRecord(v);
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
  out.push(attestationFromRecord(v, { ...opts, marketKey }));
  return out;
}
