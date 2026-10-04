// Off-chain checks: message layout, signing, and the dataset numbers.
import { expect } from "chai";
import { readFileSync } from "fs";
import nacl from "tweetnacl";
import {
  DisputeRecord,
  OPEN_DISPUTE_RISK_BPS,
  Status,
  attestationFromRecord,
  encodeMessage,
  recordEvidenceHash,
  signAttestation,
  verifyAttestation,
} from "../scripts/lib";
import { stats } from "../scripts/stats";

const rows: DisputeRecord[] = JSON.parse(readFileSync("data/polymarket-disputes-2026.json", "utf8"));

describe("attestation encoding", () => {
  it("is 97 bytes with the PREDGE-SR-v1 domain", () => {
    const m = encodeMessage({
      marketKey: Buffer.alloc(32, 7),
      status: Status.SETTLED,
      disputeCount: 2,
      settledDifferently: 0,
      riskBps: 3354,
      settledAt: 1_780_533_259,
      observedAt: 1_780_533_300,
      evidenceHash: Buffer.alloc(32, 9),
    });
    expect(m.length).to.eq(97);
    expect(m.subarray(0, 12).toString()).to.eq("PREDGE-SR-v1");
    expect(m[44]).to.eq(Status.SETTLED);
    expect(m.readUInt16LE(47)).to.eq(3354);
  });

  it("signs and detects tampering", () => {
    const kp = nacl.sign.keyPair();
    const r = rows.find((x) => x.market_id === "2169995")!;
    const s = signAttestation(attestationFromRecord(r, 1_780_533_300, recordEvidenceHash(r)), kp.secretKey);
    expect(verifyAttestation(s)).to.eq(true);
    s.attestation.riskBps = 1;
    expect(verifyAttestation(s)).to.eq(false);
  });
});

describe("dataset", () => {
  it("reproduces the published 2026 numbers", () => {
    const s = stats(rows);
    expect(s.disputes).to.eq(3005);
    expect(s.disputed_markets).to.eq(2666);
    expect(s.disputed_twice_or_more).to.eq(323);
    expect(s.settled).to.eq(2543);
    expect(s.settled_differently_from_disputed_proposal).to.eq(853);
    expect(Math.round((853 / 2543) * 10000)).to.eq(OPEN_DISPUTE_RISK_BPS);
  });

  it("maps open markets to DISPUTED or ESCALATED with the base-rate risk", () => {
    const open = rows.filter((r) => !r.resolved_utc);
    for (const r of open) {
      const a = attestationFromRecord(r, 1, Buffer.alloc(32));
      expect([Status.DISPUTED, Status.ESCALATED]).to.include(a.status);
      expect(a.riskBps).to.eq(OPEN_DISPUTE_RISK_BPS);
    }
  });
});
