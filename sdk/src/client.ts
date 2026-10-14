// One-call helpers that chain the lower-level pieces.
import { PublicKey } from "@solana/web3.js";
import { Attestation, encodeAttestationMessage } from "./attestation.js";
import {
  FetchOptions,
  MappingOptions,
  SettlementRiskRecord,
  VerifiedSettlementRecord,
  VerifyOptions,
  attestationFromRecord,
  fetchSettlementRisk,
  verifySettlementRecord,
} from "./api.js";
import { PREDGE_GUARD_PROGRAM_ID } from "./constants.js";
import { CheckSettlementAccounts, getCheckSettlementAccounts } from "./pda.js";

export interface PreparedAttestation {
  record: SettlementRiskRecord;
  verified: VerifiedSettlementRecord;
  /** Current state of the market, ready to be signed by the attestor and relayed. */
  attestation: Attestation;
  /** The 97 bytes the attestor signs. */
  message: Uint8Array;
  marketKey: Uint8Array;
  /** Accounts for the `check_settlement` CPI on this market. */
  accounts: CheckSettlementAccounts;
}

/**
 * Fetch the signed record for a Polymarket market id, verify it offline
 * against the pinned Predge key, and map it to the on-chain attestation.
 */
export async function prepareAttestation(
  marketId: string | number,
  opts: FetchOptions & VerifyOptions & MappingOptions & { programId?: PublicKey } = {}
): Promise<PreparedAttestation> {
  const record = await fetchSettlementRisk(marketId, opts);
  const verified = verifySettlementRecord(record, opts);
  const attestation = attestationFromRecord(verified, opts);
  return {
    record,
    verified,
    attestation,
    message: encodeAttestationMessage(attestation),
    marketKey: attestation.marketKey,
    accounts: getCheckSettlementAccounts(attestation.marketKey, opts.programId ?? PREDGE_GUARD_PROGRAM_ID),
  };
}
