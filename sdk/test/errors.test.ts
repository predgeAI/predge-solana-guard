import { describe, expect, it } from "vitest";
import { GUARD_ERRORS, parseGuardError } from "../src/index.js";
import { readJson } from "./helpers.js";

describe("guard errors", () => {
  it("match the IDL codes, names and messages", () => {
    const idl = readJson("target/idl/predge_guard.json");
    expect(Object.keys(GUARD_ERRORS).length).toBe(idl.errors.length);
    for (const e of idl.errors) {
      const ours = (GUARD_ERRORS as any)[e.code];
      expect(ours.name).toBe(e.name);
      expect(ours.msg).toBe(e.msg);
    }
  });

  it("parse the real devnet logs of the blocked vault.release transactions", () => {
    // meta.logMessages of the two blocked releases in the README devnet table.
    const fx = readJson("sdk/test/fixtures/devnet-blocked-release-logs.json");
    const got = fx.txs.map((t: any) => parseGuardError(t.logs));
    expect(got).toEqual([
      { code: 6011, name: "MarketDisputed" },
      { code: 6012, name: "MarketEscalated" },
    ]);
    fx.txs.forEach((t: any, i: number) => expect(t.err.InstructionError[1].Custom).toBe(got[i].code));
    expect(parseGuardError({ message: "Simulation failed", logs: fx.txs[0].logs })).toEqual({ code: 6011, name: "MarketDisputed" });
  });

  it("do not match consumer errors that share a number", () => {
    const logs = ["Program log: AnchorError caused by account: market_risk. Error Code: WrongMarket. Error Number: 6001. Error Message: x."];
    expect(parseGuardError(logs)).toBeNull();
    expect(parseGuardError("custom program error: 0x1771")).toBeNull();
    expect(parseGuardError(null)).toBeNull();
  });
});
