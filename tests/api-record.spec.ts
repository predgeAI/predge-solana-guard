// Off-chain checks for records signed by api.predge.io (fixture saved from
// GET /v1/settlement-risk/2169995 on 2026-10-07).
import { expect } from "chai";
import { readFileSync } from "fs";
import { ApiRecord, canonicalize, currentAttestation, timelineAttestations, verifyApiRecord } from "../scripts/api-record";
import { OPEN_DISPUTE_RISK_BPS, Status, polymarketKey, sha256, toUnix } from "../scripts/lib";

const fixture = (): ApiRecord => JSON.parse(readFileSync("examples/api-settlement-risk-2169995.json", "utf8"));

describe("api.predge.io signed record", () => {
  it("re-canonicalises the payload byte for byte", () => {
    const r = fixture();
    expect(canonicalize(r.attestation.payload)).to.eq(r.attestation.canonical);
  });

  it("verifies against the pinned Predge key and hashes the canonical bytes", () => {
    const r = fixture();
    const v = verifyApiRecord(r);
    expect(v.evidenceHash.equals(sha256(Buffer.from(r.attestation.canonical, "utf8")))).to.eq(true);
  });

  it("rejects a tampered payload", () => {
    const r = fixture();
    r.attestation.payload.open_dispute = true;
    expect(() => verifyApiRecord(r)).to.throw(/canonical/);
    const r2 = fixture();
    r2.attestation.canonical = r2.attestation.canonical.replace('"open_dispute":false', '"open_dispute":true');
    r2.attestation.payload.open_dispute = true;
    expect(() => verifyApiRecord(r2)).to.throw(/signature/);
  });

  it("rejects a record signed by another key", () => {
    expect(() => verifyApiRecord(fixture(), "00".repeat(32))).to.throw(/pinned/);
  });

  it("maps the signed resolution path to DISPUTED, ESCALATED, SETTLED", () => {
    const v = verifyApiRecord(fixture());
    const settledAt = toUnix("2026-06-04T00:34:19Z");
    const t = timelineAttestations(v, { settledAt });
    expect(t.map((a) => a.status)).to.deep.eq([Status.DISPUTED, Status.ESCALATED, Status.SETTLED]);
    expect(t[0].riskBps).to.eq(OPEN_DISPUTE_RISK_BPS);
    expect(t[2].riskBps).to.eq(0);
    expect(t[2].settledAt).to.eq(settledAt);
    expect(t[2].settledDifferently).to.eq(0); // disputed proposal "No", resolved "No"
    for (let i = 1; i < t.length; i++) expect(t[i].observedAt).to.be.greaterThan(t[i - 1].observedAt);
    expect(t[0].marketKey.equals(polymarketKey(v.payload.uma_question_id))).to.eq(true);
  });

  it("maps an open second dispute to ESCALATED", () => {
    const v = verifyApiRecord(fixture());
    v.payload = { ...v.payload, resolved_on_chain: false, open_dispute: true, onchain_resolution: null };
    expect(currentAttestation(v).status).to.eq(Status.ESCALATED);
  });
});
