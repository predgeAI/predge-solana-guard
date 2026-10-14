import { PublicKey } from "@solana/web3.js";
import { CONFIG_SEED, MARKET_RISK_SEED, PREDGE_GUARD_PROGRAM_ID } from "./constants.js";
import { expectLength } from "./bytes.js";

/** Config PDA: seeds ["config"]. Returns [address, bump]. */
export function findConfigPda(programId: PublicKey = PREDGE_GUARD_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

/** MarketRisk PDA: seeds ["risk", market_key]. Returns [address, bump]. */
export function findMarketRiskPda(marketKey: Uint8Array, programId: PublicKey = PREDGE_GUARD_PROGRAM_ID): [PublicKey, number] {
  expectLength(marketKey, 32, "marketKey");
  return PublicKey.findProgramAddressSync([MARKET_RISK_SEED, marketKey], programId);
}

/** The accounts a consumer program passes for the `check_settlement` CPI. */
export interface CheckSettlementAccounts {
  /** The guard program (CPI target). */
  predgeGuard: PublicKey;
  /** Guard config PDA, read-only. */
  guardConfig: PublicKey;
  /** The market's MarketRisk PDA, read-only. */
  marketRisk: PublicKey;
}

/**
 * The three accounts a consumer needs for `predge_guard::cpi::check_settlement`.
 * Property names match `programs/example-consumer` (`guard_config`,
 * `market_risk`, `predge_guard`), so the object can be passed straight into
 * an Anchor `.accountsPartial({...})` call.
 */
export function getCheckSettlementAccounts(
  marketKey: Uint8Array,
  programId: PublicKey = PREDGE_GUARD_PROGRAM_ID
): CheckSettlementAccounts {
  return {
    predgeGuard: programId,
    guardConfig: findConfigPda(programId)[0],
    marketRisk: findMarketRiskPda(marketKey, programId)[0],
  };
}
