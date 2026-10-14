import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  CONFIG_ACCOUNT_LEN,
  EXAMPLE_CONSUMER_PROGRAM_ID,
  MARKET_RISK_ACCOUNT_LEN,
  PREDGE_GUARD_PROGRAM_ID,
  Status,
  decodeConfig,
  decodeMarketRisk,
  evaluateGate,
  findConfigPda,
  findMarketRiskPda,
  getCheckSettlementAccounts,
  polymarketMarketKey,
} from "../src/index.js";
import { hex, readJson } from "./helpers.js";

// Raw account data read from devnet on 14 Oct 2026 (getAccountInfo).
const snapshot = readJson("sdk/test/fixtures/devnet-accounts-2026-10-14.json");
const acct = (label: string) => {
  const a = snapshot.accounts.find((x: any) => x.label === label);
  return { ...a, data: Uint8Array.from(Buffer.from(a.data_hex, "hex")) };
};
const QID_1484949 = readJson("examples/api-settlement-risk-1484949.json").attestation.payload.uma_question_id;
const QID_2169995 = readJson("examples/api-settlement-risk-2169995.json").attestation.payload.uma_question_id;

const guardIdl = readJson("target/idl/predge_guard.json");
const consumerIdl = readJson("target/idl/example_consumer.json");

describe("program IDs", () => {
  it("match the IDLs and Anchor.toml", () => {
    expect(PREDGE_GUARD_PROGRAM_ID.toBase58()).toBe(guardIdl.address);
    expect(EXAMPLE_CONSUMER_PROGRAM_ID.toBase58()).toBe(consumerIdl.address);
  });
});

describe("PDAs", () => {
  it("derive the devnet config PDA and its stored bump", () => {
    const cfg = acct("config");
    const [addr, bump] = findConfigPda();
    expect(addr.toBase58()).toBe(cfg.address);
    expect(bump).toBe(cfg.data[80]);
  });

  it("derive the devnet MarketRisk PDAs from the UMA question ids", () => {
    for (const [label, qid] of [
      ["market_risk polymarket 1484949", QID_1484949],
      ["market_risk polymarket 2169995", QID_2169995],
    ]) {
      const a = acct(label);
      const [addr, bump] = findMarketRiskPda(polymarketMarketKey(qid));
      expect(addr.toBase58()).toBe(a.address);
      expect(bump).toBe(a.data[MARKET_RISK_ACCOUNT_LEN - 1]);
    }
  });

  it("honour a custom program id", () => {
    const other = new PublicKey("11111111111111111111111111111112");
    const [a] = findConfigPda(other);
    expect(a.equals(PublicKey.findProgramAddressSync([Buffer.from("config")], other)[0])).toBe(true);
  });

  it("reject a market key that is not 32 bytes", () => {
    expect(() => findMarketRiskPda(new Uint8Array(31))).toThrow(/32/);
  });
});

describe("check_settlement CPI accounts", () => {
  it("returns the three accounts named as in example-consumer's Release context", () => {
    const key = polymarketMarketKey(QID_1484949);
    const accts = getCheckSettlementAccounts(key);
    expect(accts.predgeGuard.equals(PREDGE_GUARD_PROGRAM_ID)).toBe(true);
    expect(accts.guardConfig.toBase58()).toBe(acct("config").address);
    expect(accts.marketRisk.toBase58()).toBe(acct("market_risk polymarket 1484949").address);

    const release = consumerIdl.instructions.find((i: any) => i.name === "release");
    const camel = (s: string) => s.replace(/_(\w)/g, (_: string, c: string) => c.toUpperCase());
    const names = release.accounts.map((a: any) => camel(a.name));
    for (const k of Object.keys(accts)) expect(names).toContain(k);
    expect(release.accounts.find((a: any) => a.name === "predge_guard").address).toBe(PREDGE_GUARD_PROGRAM_ID.toBase58());
  });
});

describe("account decoding", () => {
  const coder = new BorshAccountsCoder(guardIdl);

  it("decodes the devnet config like Anchor does", () => {
    const { data } = acct("config");
    expect(data.length).toBe(CONFIG_ACCOUNT_LEN);
    const ours = decodeConfig(data);
    const theirs = coder.decode("Config", Buffer.from(data));
    expect(ours.admin.toBase58()).toBe(theirs.admin.toBase58());
    expect(ours.attestor.toBase58()).toBe(theirs.attestor.toBase58());
    expect(ours.coolingSecs).toBe(theirs.cooling_secs.toNumber());
    expect(ours.bump).toBe(theirs.bump);
    expect(ours.coolingSecs).toBe(3600);
  });

  it("decodes the devnet MarketRisk records like Anchor does", () => {
    for (const label of ["market_risk polymarket 1484949", "market_risk polymarket 2169995"]) {
      const { data } = acct(label);
      expect(data.length).toBe(MARKET_RISK_ACCOUNT_LEN);
      const ours = decodeMarketRisk(data);
      const t = coder.decode("MarketRisk", Buffer.from(data));
      expect(hex(ours.marketKey)).toBe(Buffer.from(t.market_key).toString("hex"));
      expect(ours.status).toBe(t.status);
      expect(ours.disputeCount).toBe(t.dispute_count);
      expect(ours.settledDifferently).toBe(t.settled_differently);
      expect(ours.riskBps).toBe(t.risk_bps);
      expect(ours.settledAt).toBe(t.settled_at.toNumber());
      expect(ours.observedAt).toBe(t.observed_at.toNumber());
      expect(hex(ours.evidenceHash)).toBe(Buffer.from(t.evidence_hash).toString("hex"));
      expect(ours.updatedSlot.toString()).toBe(t.updated_slot.toString());
      expect(ours.bump).toBe(t.bump);
    }
  });

  it("reads the expected state for Polymarket 1484949 on devnet", () => {
    const r = decodeMarketRisk(acct("market_risk polymarket 1484949").data);
    expect(hex(r.marketKey)).toBe(hex(polymarketMarketKey(QID_1484949)));
    expect(r.status).toBe(Status.SETTLED);
    expect(r.disputeCount).toBe(2);
    expect(r.riskBps).toBe(0);
    expect(new Date(r.settledAt * 1000).toISOString()).toBe("2026-04-05T06:13:09.000Z");
  });

  it("rejects the wrong discriminator or a short buffer", () => {
    expect(() => decodeMarketRisk(acct("config").data)).toThrow();
    expect(() => decodeConfig(acct("market_risk polymarket 1484949").data)).toThrow(/discriminator/);
    expect(() => decodeMarketRisk(new Uint8Array(50))).toThrow(/102/);
  });
});

describe("evaluateGate (off-chain mirror of assert_final)", () => {
  // Same cases as `gate_blocks_until_final` in lib.rs.
  const r = (status: number, settledAt: number) => ({ status, settledAt });
  it("blocks until settled and past the cooling window", () => {
    expect(evaluateGate(r(Status.PROPOSED, 0), 3600, 10_000)).toEqual({ final: false, error: "SettlementNotFinal" });
    expect(evaluateGate(r(Status.DISPUTED, 0), 3600, 10_000)).toEqual({ final: false, error: "MarketDisputed" });
    expect(evaluateGate(r(Status.ESCALATED, 0), 3600, 10_000)).toEqual({ final: false, error: "MarketEscalated" });
    expect(evaluateGate(r(Status.SETTLED, 9_000), 3600, 10_000)).toEqual({ final: false, error: "CoolingPeriod" });
    expect(evaluateGate(r(Status.SETTLED, 6_400), 3600, 10_000)).toEqual({ final: true });
    expect(evaluateGate(null, 3600, 10_000)).toEqual({ final: false, error: "SettlementNotFinal" });
  });
});
