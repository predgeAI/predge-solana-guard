import { BN, BorshInstructionCoder } from "@coral-xyz/anchor";
import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import {
  Attestation,
  OPEN_DISPUTE_RISK_BPS,
  Status,
  attestationProblems,
  decodeAttestationMessage,
  encodeAttestationArg,
  encodeAttestationMessage,
  polymarketMarketKey,
  sha256,
  signAttestation,
  verifyAttestationSignature,
} from "../src/index.js";
import { hex, readJson, rootDepsInstalled } from "./helpers.js";

// Same vector as `message_layout_is_fixed` in programs/predge_guard/src/lib.rs
// and "is 97 bytes with the PREDGE-SR-v1 domain" in tests/attestation.spec.ts.
const RUST_VECTOR: Attestation = {
  marketKey: new Uint8Array(32).fill(7),
  status: Status.SETTLED,
  disputeCount: 2,
  settledDifferently: 0,
  riskBps: 3354,
  settledAt: 1_780_533_259,
  observedAt: 1_780_533_300,
  evidenceHash: new Uint8Array(32).fill(9),
};

// Expected bytes written out field by field from the layout table in README.md.
const RUST_VECTOR_HEX =
  Buffer.from("PREDGE-SR-v1").toString("hex") +
  "07".repeat(32) +
  "04" + // status SETTLED
  "02" + // dispute_count
  "00" + // settled_differently
  "1a0d" + // 3354 u16 LE
  "0bc8206a00000000" + // 1_780_533_259 i64 LE
  "34c8206a00000000" + // 1_780_533_300 i64 LE
  "09".repeat(32);

describe("attestation message (97 bytes)", () => {
  it("matches the Rust unit-test vector byte for byte", () => {
    const m = encodeAttestationMessage(RUST_VECTOR);
    expect(m.length).toBe(97);
    expect(Buffer.from(m.subarray(0, 12)).toString()).toBe("PREDGE-SR-v1");
    expect(m[44]).toBe(Status.SETTLED);
    expect(Buffer.from(m).readUInt16LE(47)).toBe(3354);
    expect(hex(m.subarray(65))).toBe("09".repeat(32));
    expect(hex(m)).toBe(RUST_VECTOR_HEX);
  });

  it("round-trips through decode", () => {
    const back = decodeAttestationMessage(encodeAttestationMessage(RUST_VECTOR));
    expect(back).toEqual({ ...RUST_VECTOR, marketKey: RUST_VECTOR.marketKey, evidenceHash: RUST_VECTOR.evidenceHash });
  });

  it("encodes negative and large i64 timestamps", () => {
    const a = { ...RUST_VECTOR, settledAt: -1, observedAt: 2 ** 40 + 5 };
    const back = decodeAttestationMessage(encodeAttestationMessage(a));
    expect(back.settledAt).toBe(-1);
    expect(back.observedAt).toBe(2 ** 40 + 5);
  });

  it("rejects fields that do not fit their types", () => {
    expect(() => encodeAttestationMessage({ ...RUST_VECTOR, marketKey: new Uint8Array(31) })).toThrow(/marketKey/);
    expect(() => encodeAttestationMessage({ ...RUST_VECTOR, evidenceHash: new Uint8Array(33) })).toThrow(/evidenceHash/);
    expect(() => encodeAttestationMessage({ ...RUST_VECTOR, status: 256 })).toThrow(/status/);
    expect(() => encodeAttestationMessage({ ...RUST_VECTOR, riskBps: 65536 })).toThrow(/riskBps/);
    expect(() => encodeAttestationMessage({ ...RUST_VECTOR, settledAt: 1.5 })).toThrow(/settledAt/);
  });

  it("rejects a wrong domain or length on decode", () => {
    const m = encodeAttestationMessage(RUST_VECTOR);
    m[0] = 0x58;
    expect(() => decodeAttestationMessage(m)).toThrow(/domain/);
    expect(() => decodeAttestationMessage(new Uint8Array(96))).toThrow(/97/);
  });

  it("post_attestation argument equals Anchor's Borsh encoding from the IDL", () => {
    const coder = new BorshInstructionCoder(readJson("target/idl/predge_guard.json"));
    const anchorData = coder.encode("post_attestation", {
      att: {
        market_key: Array.from(RUST_VECTOR.marketKey),
        status: RUST_VECTOR.status,
        dispute_count: RUST_VECTOR.disputeCount,
        settled_differently: RUST_VECTOR.settledDifferently,
        risk_bps: RUST_VECTOR.riskBps,
        settled_at: new BN(RUST_VECTOR.settledAt),
        observed_at: new BN(RUST_VECTOR.observedAt),
        evidence_hash: Array.from(RUST_VECTOR.evidenceHash),
      },
    });
    expect(hex(anchorData.subarray(8))).toBe(hex(encodeAttestationArg(RUST_VECTOR)));
    expect(hex(encodeAttestationArg(RUST_VECTOR))).toBe(RUST_VECTOR_HEX.slice(24));
  });
});

describe("market key", () => {
  it("is sha256('polymarket:' + lowercase question id)", () => {
    const qid = "0x0382B71B4DF8E161D7947966FEF8E5F6CC2D29B0285F87761E569B043E68F83D";
    expect(hex(polymarketMarketKey(qid))).toBe(hex(sha256(`polymarket:${qid.toLowerCase()}`)));
  });
  it("rejects a malformed question id", () => {
    expect(() => polymarketMarketKey("2169995")).toThrow(/question id/);
  });
});

describe("program-side field checks", () => {
  it("accepts a valid settled attestation", () => {
    expect(attestationProblems(RUST_VECTOR, RUST_VECTOR.observedAt)).toEqual([]);
  });
  it("mirrors the post_attestation require! checks", () => {
    expect(attestationProblems({ ...RUST_VECTOR, status: 0 }).join()).toMatch(/InvalidStatus/);
    expect(attestationProblems({ ...RUST_VECTOR, status: 5 }).join()).toMatch(/InvalidStatus/);
    expect(attestationProblems({ ...RUST_VECTOR, riskBps: 10_001 }).join()).toMatch(/InvalidRisk/);
    expect(attestationProblems({ ...RUST_VECTOR, settledDifferently: 2 }).join()).toMatch(/InvalidStatus/);
    expect(attestationProblems({ ...RUST_VECTOR, settledAt: 0 }).join()).toMatch(/settledAt/);
    expect(attestationProblems({ ...RUST_VECTOR, observedAt: 1000 + 301 }, 1000).join()).toMatch(/FutureAttestation/);
    expect(attestationProblems({ ...RUST_VECTOR, observedAt: 1000 + 300 }, 1000)).toEqual([]);
  });
});

describe("signing", () => {
  const seed = sha256("sdk-test-attestor");
  const secret64 = new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]);

  it("signs with a 32-byte seed or a 64-byte secret key, and detects tampering", () => {
    const a = signAttestation(RUST_VECTOR, seed);
    const b = signAttestation(RUST_VECTOR, secret64);
    expect(hex(a.signature)).toBe(hex(b.signature));
    expect(verifyAttestationSignature(RUST_VECTOR, a.signature, a.attestor)).toBe(true);
    expect(verifyAttestationSignature({ ...RUST_VECTOR, riskBps: 1 }, a.signature, a.attestor)).toBe(false);
    expect(verifyAttestationSignature(RUST_VECTOR, a.signature, ed25519.getPublicKey(sha256("other")))).toBe(false);
  });

  it("rejects a 64-byte key whose public half does not match", () => {
    const bad = new Uint8Array(secret64);
    bad[40] ^= 1;
    expect(() => signAttestation(RUST_VECTOR, bad)).toThrow(/public half/);
  });
});

describe.skipIf(!rootDepsInstalled)("cross-check with scripts/lib.ts (needs root npm install)", () => {
  it("encodes every dataset row identically to scripts/lib.ts and signs verifiably for tweetnacl", async () => {
    const lib = await import("../../scripts/lib.js");
    const nacl = (await import("tweetnacl")).default;
    const rows = readJson<any[]>("data/polymarket-disputes-2026.json");
    expect(rows.length).toBe(2666);
    const seed = sha256("sdk-cross-check");
    for (const r of rows) {
      const a = lib.attestationFromRecord(r, 1_780_533_300, lib.recordEvidenceHash(r));
      const ours = encodeAttestationMessage(a);
      expect(hex(ours)).toBe(lib.encodeMessage(a).toString("hex"));
      expect(hex(polymarketMarketKey(r.question_id))).toBe(a.marketKey.toString("hex"));
    }
    const a = lib.attestationFromRecord(rows[0], 1_780_533_300, lib.recordEvidenceHash(rows[0]));
    const s = signAttestation(a, seed);
    expect(nacl.sign.detached.verify(lib.encodeMessage(a), s.signature, s.attestor)).toBe(true);
  });

  it("uses the same OPEN_DISPUTE_RISK_BPS and status values", async () => {
    const lib = await import("../../scripts/lib.js");
    expect(OPEN_DISPUTE_RISK_BPS).toBe(lib.OPEN_DISPUTE_RISK_BPS);
    expect({ ...Status }).toEqual({ ...lib.Status });
  });
});
