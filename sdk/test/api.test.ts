import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import {
  OPEN_DISPUTE_RISK_BPS,
  PREDGE_ATTESTATION_KEY_HEX,
  SettlementRiskRecord,
  Status,
  attestationFromRecord,
  attestationKeysFrom,
  canonicalize,
  fetchPredgeKeys,
  fetchSettlementRisk,
  polymarketMarketKey,
  prepareAttestation,
  sha256,
  timelineFromRecord,
  toHex,
  verifySettlementRecord,
} from "../src/index.js";
import { hex, readJson, rootDepsInstalled } from "./helpers.js";

// Saved from GET /v1/settlement-risk/<id>: the examples/ files on 7 Oct 2026
// (before the API added content_hash), the sdk fixture on 14 Oct 2026 (with
// content_hash, kid and envelope_signature).
const OLD_2169995 = "examples/api-settlement-risk-2169995.json";
const OLD_1484949 = "examples/api-settlement-risk-1484949.json";
const NEW_1484949 = "sdk/test/fixtures/api-settlement-risk-1484949-2026-10-14.json";
const KEYS = "sdk/test/fixtures/predge-keys-2026-10-14.json";
const rec = (p: string): SettlementRiskRecord => readJson(p);
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("pinned key", () => {
  it("is the active attestation key in the published keys document", () => {
    const doc = readJson(KEYS);
    expect(attestationKeysFrom(doc)).toEqual([PREDGE_ATTESTATION_KEY_HEX]);
  });
  it("ignores keys with another role or inactive keys", () => {
    const doc = readJson(KEYS);
    doc.keys.push({ kid: "x", algorithm: "ed25519", public_key: "AB".repeat(32), active: false, role: "attestation" });
    expect(attestationKeysFrom(doc)).toEqual([PREDGE_ATTESTATION_KEY_HEX]);
  });
});

describe("verifySettlementRecord", () => {
  it("verifies a current record: content_hash, signature, kid and envelope", () => {
    const r = rec(NEW_1484949);
    const v = verifySettlementRecord(r);
    expect(v.contentHashChecked).toBe(true);
    expect(v.envelopeSignatureChecked).toBe(true);
    expect(v.signer).toBe(PREDGE_ATTESTATION_KEY_HEX);
    expect(toHex(v.evidenceHash)).toBe(r.attestation.content_hash);
    expect(toHex(v.evidenceHash)).toBe(toHex(sha256(r.attestation.canonical)));
    expect(v.title).toBe("Netanyahu out by March 31?");
  });

  it("verifies the older fixtures when content_hash is not required", () => {
    for (const p of [OLD_2169995, OLD_1484949]) {
      expect(() => verifySettlementRecord(rec(p))).toThrow(/content_hash/);
      const v = verifySettlementRecord(rec(p), { requireContentHash: false });
      expect(v.contentHashChecked).toBe(false);
      expect(toHex(v.evidenceHash)).toBe(toHex(sha256(rec(p).attestation.canonical)));
    }
  });

  it("re-canonicalises the payload byte for byte", () => {
    for (const p of [OLD_2169995, OLD_1484949, NEW_1484949]) {
      const r = rec(p);
      expect(canonicalize(r.attestation.payload)).toBe(r.attestation.canonical);
    }
  });

  it("rejects a tampered payload", () => {
    const r = rec(NEW_1484949);
    r.attestation.payload.open_dispute = true;
    expect(() => verifySettlementRecord(r)).toThrow(/canonical/);
  });

  it("rejects payload and canonical tampered together (signature)", () => {
    const r = rec(NEW_1484949);
    r.attestation.canonical = r.attestation.canonical.replace('"open_dispute":false', '"open_dispute":true');
    r.attestation.payload.open_dispute = true;
    r.attestation.content_hash = toHex(sha256(r.attestation.canonical));
    expect(() => verifySettlementRecord(r)).toThrow(/signature/);
  });

  it("rejects a content_hash that is not sha256(canonical)", () => {
    const r = rec(NEW_1484949);
    r.attestation.content_hash = "00".repeat(32);
    expect(() => verifySettlementRecord(r)).toThrow(/content_hash/);
  });

  it("rejects a tampered envelope", () => {
    const r = rec(NEW_1484949);
    r.attestation.data_basis = "changed";
    expect(() => verifySettlementRecord(r)).toThrow(/envelope_signature/);
    const r2 = rec(OLD_1484949);
    expect(() => verifySettlementRecord(r2, { requireContentHash: false, requireEnvelopeSignature: true })).toThrow(/envelope_signature/);
  });

  it("rejects a record signed by a key that is not trusted, even with a valid signature", () => {
    const seed = sha256("not-predge");
    const pk = toHex(ed25519.getPublicKey(seed));
    const r = rec(NEW_1484949);
    const canonical = r.attestation.canonical;
    r.attestation.public_key = pk;
    r.attestation.kid = pk.slice(0, 16);
    r.attestation.signature = toHex(ed25519.sign(new TextEncoder().encode(canonical), seed));
    delete r.attestation.envelope_signature;
    expect(() => verifySettlementRecord(r)).toThrow(/not a trusted/);
    // Trusting that key explicitly makes it pass, which shows the check is the trust list.
    expect(verifySettlementRecord(r, { trustedKeys: [pk] }).signer).toBe(pk);
  });

  it("rejects a kid that does not match the key", () => {
    const r = rec(NEW_1484949);
    r.attestation.kid = "ffffffffffffffff";
    expect(() => verifySettlementRecord(r)).toThrow(/kid/);
  });

  it("rejects a non-ed25519 record and a record without attestation", () => {
    const r = rec(NEW_1484949);
    r.attestation.algorithm = "secp256k1";
    expect(() => verifySettlementRecord(r)).toThrow(/algorithm/);
    expect(() => verifySettlementRecord({ market: {} } as any)).toThrow(/no attestation/);
  });
});

describe("mapping a signed record to attestations", () => {
  it("maps 2169995 to DISPUTED, ESCALATED, SETTLED with evidence_hash = sha256(canonical)", () => {
    const v = verifySettlementRecord(rec(OLD_2169995), { requireContentHash: false });
    const settledAt = unix("2026-06-04T00:34:19Z");
    const t = timelineFromRecord(v, { settledAt });
    expect(t.map((a) => a.status)).toEqual([Status.DISPUTED, Status.ESCALATED, Status.SETTLED]);
    expect(t.map((a) => a.disputeCount)).toEqual([1, 2, 2]);
    expect(t[0].riskBps).toBe(OPEN_DISPUTE_RISK_BPS);
    expect(t[2].riskBps).toBe(0);
    expect(t[2].settledAt).toBe(settledAt);
    expect(t[2].settledDifferently).toBe(0);
    for (let i = 1; i < t.length; i++) expect(t[i].observedAt).toBeGreaterThan(t[i - 1].observedAt);
    for (const a of t) {
      expect(hex(a.marketKey)).toBe(hex(polymarketMarketKey(v.payload.uma_question_id)));
      expect(hex(a.evidenceHash)).toBe(hex(v.evidenceHash));
    }
  });

  it("uses checked_at as settledAt when the resolution time is not given", () => {
    const v = verifySettlementRecord(rec(NEW_1484949));
    const a = attestationFromRecord(v);
    expect(a.status).toBe(Status.SETTLED);
    expect(a.settledAt).toBe(unix(v.payload.checked_at));
    expect(a.observedAt).toBe(unix(v.payload.checked_at));
  });

  it("maps open disputes and pending proposals", () => {
    const v = verifySettlementRecord(rec(NEW_1484949));
    const open = { ...v, payload: { ...v.payload, resolved_on_chain: false, open_dispute: true, onchain_resolution: null } };
    expect(attestationFromRecord(open).status).toBe(Status.ESCALATED);
    const once = { ...open, payload: { ...open.payload, dispute_count: "1", sent_to_uma_vote: false } };
    expect(attestationFromRecord(once).status).toBe(Status.DISPUTED);
    const vote = { ...once, payload: { ...once.payload, sent_to_uma_vote: true } };
    expect(attestationFromRecord(vote).status).toBe(Status.ESCALATED);
    const proposed = { ...once, payload: { ...once.payload, open_dispute: false, current_proposal: { proposed: "Yes" } } };
    expect(attestationFromRecord(proposed)).toMatchObject({ status: Status.PROPOSED, riskBps: 0, settledAt: 0 });
    const nothing = { ...proposed, payload: { ...proposed.payload, current_proposal: null } };
    expect(() => attestationFromRecord(nothing)).toThrow(/nothing|no proposal/);
  });

  it("flags settled_differently when the outcome differs from the last disputed proposal", () => {
    const v = verifySettlementRecord(rec(NEW_1484949));
    const flipped = { ...v, payload: { ...v.payload, onchain_resolution: { outcome: "Yes" } } };
    const last = v.payload.disputes[v.payload.disputes.length - 1].disputed_proposal;
    expect(attestationFromRecord(flipped).settledDifferently).toBe(last === "Yes" ? 0 : 1);
  });

  it.skipIf(!rootDepsInstalled)("produces the same attestations as scripts/api-record.ts (needs root npm install)", async () => {
    const script = await import("../../scripts/api-record.js");
    for (const [p, settledAt] of [
      [OLD_2169995, unix("2026-06-04T00:34:19Z")],
      [OLD_1484949, unix("2026-04-05T06:13:09Z")],
      [NEW_1484949, undefined],
    ] as const) {
      const ours = timelineFromRecord(verifySettlementRecord(rec(p), { requireContentHash: false }), { settledAt });
      const theirs = script.timelineAttestations(script.verifyApiRecord(rec(p) as any), { settledAt });
      expect(ours.length).toBe(theirs.length);
      ours.forEach((a, i) => {
        const b = theirs[i];
        expect({ ...a, marketKey: hex(a.marketKey), evidenceHash: hex(a.evidenceHash) }).toEqual({
          ...b,
          marketKey: b.marketKey.toString("hex"),
          evidenceHash: b.evidenceHash.toString("hex"),
        });
      });
    }
  });
});

describe("fetching (mocked fetch)", () => {
  const mockFetch = (routes: Record<string, unknown>, status = 200) => {
    const calls: string[] = [];
    const f = async (url: string) => {
      calls.push(url);
      const body = routes[url];
      return {
        ok: status === 200 && body !== undefined,
        status: body === undefined ? 404 : status,
        json: async () => body,
        text: async () => JSON.stringify(body ?? { error: "not found" }),
      };
    };
    return { f, calls };
  };

  it("fetches a record and the keys document from the API base", async () => {
    const { f, calls } = mockFetch({
      "https://example.test/v1/settlement-risk/1484949": rec(NEW_1484949),
      "https://example.test/.well-known/predge-keys.json": readJson(KEYS),
    });
    const r = await fetchSettlementRisk(1484949, { apiBase: "https://example.test/", fetch: f });
    expect(r.market.market_id).toBe("1484949");
    const doc = await fetchPredgeKeys({ apiBase: "https://example.test", fetch: f });
    expect(attestationKeysFrom(doc)).toEqual([PREDGE_ATTESTATION_KEY_HEX]);
    expect(calls).toEqual(["https://example.test/v1/settlement-risk/1484949", "https://example.test/.well-known/predge-keys.json"]);
  });

  it("prepareAttestation fetches, verifies and maps in one call", async () => {
    const { f } = mockFetch({ "https://api.predge.io/v1/settlement-risk/1484949": rec(NEW_1484949) });
    const p = await prepareAttestation("1484949", { fetch: f });
    expect(p.attestation.status).toBe(Status.SETTLED);
    expect(p.message.length).toBe(97);
    expect(p.accounts.marketRisk.toBase58()).toBe("DDn4AwFGJTeryNcLqnEqUm6k5kShCNznWCCXbPQNAurG");
  });

  it("reports HTTP errors and non-records", async () => {
    const { f } = mockFetch({});
    await expect(fetchSettlementRisk("999", { fetch: f })).rejects.toThrow(/HTTP 404/);
    const { f: f2 } = mockFetch({ "https://api.predge.io/v1/settlement-risk/1": { error: "x" } });
    await expect(fetchSettlementRisk("1", { fetch: f2 })).rejects.toThrow(/not a signed/);
  });

  it("rejects a record tampered in transit", async () => {
    const bad = rec(NEW_1484949);
    bad.attestation.payload.resolved_on_chain = false;
    const { f } = mockFetch({ "https://api.predge.io/v1/settlement-risk/1484949": bad });
    await expect(prepareAttestation("1484949", { fetch: f })).rejects.toThrow(/canonical/);
  });
});
