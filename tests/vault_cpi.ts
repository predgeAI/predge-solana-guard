// Example consumer: a vault that calls predge_guard::check_settlement via CPI
// before releasing funds. Runs after tests/predge_guard.ts (file order) on the same local
// validator, so it reuses (or creates) the guard config and points it at a
// fresh attestor key of its own.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import nacl from "tweetnacl";
import { ExampleConsumer } from "../target/types/example_consumer";
import { PredgeGuard } from "../target/types/predge_guard";
import { Attestation, OPEN_DISPUTE_RISK_BPS, Status, ed25519Ix, pda, sha256, signAttestation, toAnchorArg } from "../scripts/lib";

const COOLING_SECS = 3600;

describe("example_consumer (CPI into check_settlement)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const guard = anchor.workspace.PredgeGuard as Program<PredgeGuard>;
  const vaultProgram = anchor.workspace.ExampleConsumer as Program<ExampleConsumer>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const attestor = nacl.sign.keyPair();
  const configPda = pda(guard.programId, Buffer.from("config"));
  const riskPda = (key: Buffer) => pda(guard.programId, Buffer.from("risk"), key);

  // Fresh market key per run so the suite is repeatable on one validator.
  const marketKey = sha256(`cpi-test:${Date.now()}:polymarket:2169995`);
  const otherKey = sha256(`cpi-test:${Date.now()}:other`);
  const beneficiary = Keypair.generate().publicKey;
  const vaultId = new anchor.BN(42);
  const vaultPda = pda(vaultProgram.programId, Buffer.from("vault"), payer.publicKey.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8));
  const amount = 0.1 * LAMPORTS_PER_SOL;
  const t0 = Date.parse("2026-06-01T04:00:05Z") / 1000;

  const att = (over: Partial<Attestation>): Attestation => ({
    marketKey,
    status: Status.PROPOSED,
    disputeCount: 0,
    settledDifferently: 0,
    riskBps: 0,
    settledAt: 0,
    observedAt: t0,
    evidenceHash: sha256("evidence"),
    ...over,
  });

  async function post(a: Attestation) {
    const signed = signAttestation(a, attestor.secretKey);
    const ix = await guard.methods
      .postAttestation(toAnchorArg(a) as any)
      .accountsPartial({
        payer: payer.publicKey,
        config: configPda,
        marketRisk: riskPda(a.marketKey),
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return provider.sendAndConfirm(new Transaction().add(ed25519Ix(signed), ix));
  }

  const release = (market = marketKey) =>
    vaultProgram.methods
      .release()
      .accountsPartial({
        caller: payer.publicKey,
        vault: vaultPda,
        beneficiary,
        guardConfig: configPda,
        marketRisk: riskPda(market),
        predgeGuard: guard.programId,
      })
      .rpc();

  async function expectError(p: Promise<unknown>, code: string) {
    try {
      await p;
      expect.fail(`expected ${code}`);
    } catch (e: any) {
      const s = String(e?.message ?? e) + JSON.stringify(e?.logs ?? e?.transactionLogs ?? "");
      expect(s).to.include(code);
    }
  }

  before(async () => {
    const attestorPk = new PublicKey(attestor.publicKey);
    if (await provider.connection.getAccountInfo(configPda)) {
      await guard.methods
        .updateConfig(attestorPk, new anchor.BN(COOLING_SECS))
        .accountsPartial({ admin: payer.publicKey, config: configPda })
        .rpc();
    } else {
      await guard.methods
        .initialize(attestorPk, new anchor.BN(COOLING_SECS))
        .accountsPartial({ admin: payer.publicKey, config: configPda, systemProgram: SystemProgram.programId })
        .rpc();
    }
    await post(att({}));
    await post(att({ marketKey: otherKey, status: Status.SETTLED, disputeCount: 1, settledAt: t0, observedAt: t0 + 1 }));
  });

  it("locks funds in the vault against the reference market", async () => {
    await vaultProgram.methods
      .deposit(vaultId, Array.from(marketKey), new anchor.BN(amount))
      .accountsPartial({ depositor: payer.publicKey, beneficiary, vault: vaultPda, systemProgram: SystemProgram.programId })
      .rpc();
    const v = await vaultProgram.account.vault.fetch(vaultPda);
    expect(v.amount.toNumber()).to.eq(amount);
  });

  it("CPI blocks release while the outcome is only proposed", async () => {
    await expectError(release(), "SettlementNotFinal");
  });

  it("CPI blocks release while the market is disputed", async () => {
    await post(att({ status: Status.DISPUTED, disputeCount: 1, riskBps: OPEN_DISPUTE_RISK_BPS, observedAt: t0 + 735 }));
    await expectError(release(), "MarketDisputed");
  });

  it("CPI blocks release while the market is escalated to a UMA vote", async () => {
    await post(att({ status: Status.ESCALATED, disputeCount: 2, riskBps: OPEN_DISPUTE_RISK_BPS, observedAt: t0 + 3176 }));
    await expectError(release(), "MarketEscalated");
  });

  it("refuses a MarketRisk account for a different market, even if that one is settled", async () => {
    await expectError(release(otherKey), "WrongMarket");
  });

  it("CPI blocks release during the cooling window after settlement", async () => {
    const now = Math.floor(Date.now() / 1000);
    await post(att({ status: Status.SETTLED, disputeCount: 2, settledAt: now - 10, observedAt: now - 5 }));
    await expectError(release(), "CoolingPeriod");
  });

  it("releases to the beneficiary once the market is final", async () => {
    // Shorten the cooling window to 0 so the settlement above is final now.
    await guard.methods
      .updateConfig(new PublicKey(attestor.publicKey), new anchor.BN(0))
      .accountsPartial({ admin: payer.publicKey, config: configPda })
      .rpc();
    const before = await provider.connection.getBalance(beneficiary);
    await release();
    const after = await provider.connection.getBalance(beneficiary);
    expect(after - before).to.be.greaterThanOrEqual(amount);
    expect(await provider.connection.getAccountInfo(vaultPda)).to.eq(null);
    await guard.methods
      .updateConfig(new PublicKey(attestor.publicKey), new anchor.BN(COOLING_SECS))
      .accountsPartial({ admin: payer.publicKey, config: configPda })
      .rpc();
  });
});
