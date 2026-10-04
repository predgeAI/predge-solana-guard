import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import nacl from "tweetnacl";
import { PredgeGuard } from "../target/types/predge_guard";
import {
  Attestation,
  OPEN_DISPUTE_RISK_BPS,
  Status,
  ed25519Ix,
  pda,
  polymarketKey,
  sha256,
  signAttestation,
  toAnchorArg,
  SignedAttestation,
} from "../scripts/lib";

const COOLING_SECS = 3600;

describe("predge_guard", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PredgeGuard as Program<PredgeGuard>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const attestor = nacl.sign.keyPair();
  const impostor = nacl.sign.keyPair();
  const configPda = pda(program.programId, Buffer.from("config"));
  const riskPda = (key: Buffer) => pda(program.programId, Buffer.from("risk"), key);

  const now = () => Math.floor(Date.now() / 1000);

  // Real market from the dataset: "MicroStrategy sells any Bitcoin by May 31, 2026?"
  const strategyQid = "0x0382b71b4df8e161d7947966fef8e5f6cc2d29b0285f87761e569b043e68f83d";
  const strategyKey = polymarketKey(strategyQid);
  const evidence = Buffer.from("fed6d15eb50da0c8e08e4a1fd95b767f7d9ced13985e246ede843705454b1f64", "hex");

  const base = (over: Partial<Attestation>): Attestation => ({
    marketKey: strategyKey,
    status: Status.PROPOSED,
    disputeCount: 0,
    settledDifferently: 0,
    riskBps: 0,
    settledAt: 0,
    observedAt: Date.parse("2026-06-01T04:00:05Z") / 1000,
    evidenceHash: evidence,
    ...over,
  });

  async function post(signed: SignedAttestation, opts: { withEd25519?: boolean; arg?: Attestation } = {}) {
    const arg = opts.arg ?? signed.attestation;
    const ix = await program.methods
      .postAttestation(toAnchorArg(arg) as any)
      .accountsPartial({
        payer: payer.publicKey,
        config: configPda,
        marketRisk: riskPda(arg.marketKey),
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction();
    if (opts.withEd25519 !== false) tx.add(ed25519Ix(signed));
    tx.add(ix);
    return provider.sendAndConfirm(tx, []);
  }

  async function expectError(p: Promise<unknown>, code: string) {
    try {
      await p;
      expect.fail(`expected ${code}`);
    } catch (e: any) {
      const s = String(e?.message ?? e) + JSON.stringify(e?.logs ?? e?.transactionLogs ?? "");
      expect(s).to.include(code);
    }
  }

  it("initializes config with the attestor key", async () => {
    await program.methods
      .initialize(new PublicKey(attestor.publicKey), new anchor.BN(COOLING_SECS))
      .accountsPartial({ admin: payer.publicKey, config: configPda, systemProgram: SystemProgram.programId })
      .rpc();
    const cfg = await program.account.config.fetch(configPda);
    expect(cfg.attestor.toBase58()).to.eq(new PublicKey(attestor.publicKey).toBase58());
    expect(cfg.coolingSecs.toNumber()).to.eq(COOLING_SECS);
  });

  it("stores a valid signed attestation", async () => {
    await post(signAttestation(base({}), attestor.secretKey));
    const r = await program.account.marketRisk.fetch(riskPda(strategyKey));
    expect(r.status).to.eq(Status.PROPOSED);
    expect(Buffer.from(r.evidenceHash).equals(evidence)).to.eq(true);
  });

  it("rejects a signature from a key that is not the attestor", async () => {
    const a = base({ status: Status.DISPUTED, disputeCount: 1, observedAt: base({}).observedAt + 10 });
    await expectError(post(signAttestation(a, impostor.secretKey)), "WrongAttestor");
  });

  it("rejects instruction args that differ from the signed bytes", async () => {
    const signed = signAttestation(
      base({ status: Status.DISPUTED, disputeCount: 1, riskBps: OPEN_DISPUTE_RISK_BPS, observedAt: base({}).observedAt + 20 }),
      attestor.secretKey
    );
    const tampered = { ...signed.attestation, status: Status.SETTLED, settledAt: 1, riskBps: 0 };
    await expectError(post(signed, { arg: tampered }), "MessageMismatch");
  });

  it("rejects a post without the Ed25519 instruction", async () => {
    const signed = signAttestation(base({ observedAt: base({}).observedAt + 30 }), attestor.secretKey);
    await expectError(post(signed, { withEd25519: false }), "MissingEd25519Ix");
  });

  it("rejects replay of an older observation", async () => {
    await expectError(post(signAttestation(base({}), attestor.secretKey)), "StaleAttestation");
  });

  it("rejects attestations dated in the future", async () => {
    const a = base({ observedAt: now() + 3600 });
    await expectError(post(signAttestation(a, attestor.secretKey)), "FutureAttestation");
  });

  describe("escrow gated on the reference market", () => {
    const beneficiary = Keypair.generate().publicKey;
    const escrowId = new anchor.BN(1);
    const escrowPda = pda(
      program.programId,
      Buffer.from("escrow"),
      payer.publicKey.toBuffer(),
      escrowId.toArrayLike(Buffer, "le", 8)
    );
    const amount = 0.25 * LAMPORTS_PER_SOL;

    const release = () =>
      program.methods
        .releaseEscrow()
        .accountsPartial({
          caller: payer.publicKey,
          config: configPda,
          marketRisk: riskPda(strategyKey),
          escrow: escrowPda,
          beneficiary,
        })
        .rpc();

    it("opens an escrow on the Strategy market", async () => {
      await program.methods
        .openEscrow(escrowId, Array.from(strategyKey), new anchor.BN(amount))
        .accountsPartial({ depositor: payer.publicKey, beneficiary, escrow: escrowPda, systemProgram: SystemProgram.programId })
        .rpc();
      const e = await program.account.escrow.fetch(escrowPda);
      expect(e.amount.toNumber()).to.eq(amount);
    });

    it("blocks release while only proposed", async () => {
      await expectError(release(), "SettlementNotFinal");
    });

    it("blocks release while disputed", async () => {
      await post(
        signAttestation(
          base({ status: Status.DISPUTED, disputeCount: 1, riskBps: OPEN_DISPUTE_RISK_BPS, observedAt: Date.parse("2026-06-01T04:12:20Z") / 1000 }),
          attestor.secretKey
        )
      );
      await expectError(release(), "MarketDisputed");
    });

    it("blocks release while escalated to a UMA vote", async () => {
      await post(
        signAttestation(
          base({ status: Status.ESCALATED, disputeCount: 2, riskBps: OPEN_DISPUTE_RISK_BPS, observedAt: Date.parse("2026-06-01T04:53:01Z") / 1000 }),
          attestor.secretKey
        )
      );
      await expectError(release(), "MarketEscalated");
      // check_settlement is the same gate, callable by any program via CPI.
      await expectError(
        program.methods.checkSettlement().accountsPartial({ config: configPda, marketRisk: riskPda(strategyKey) }).rpc(),
        "MarketEscalated"
      );
    });

    it("releases to the beneficiary once settled and past the cooling window", async () => {
      const settledAt = Date.parse("2026-06-04T00:34:19Z") / 1000;
      await post(
        signAttestation(
          base({ status: Status.SETTLED, disputeCount: 2, riskBps: 0, settledAt, observedAt: settledAt + 60 }),
          attestor.secretKey
        )
      );
      await program.methods.checkSettlement().accountsPartial({ config: configPda, marketRisk: riskPda(strategyKey) }).rpc();
      const before = await provider.connection.getBalance(beneficiary);
      await release();
      const after = await provider.connection.getBalance(beneficiary);
      expect(after - before).to.be.greaterThanOrEqual(amount);
      expect(await provider.connection.getAccountInfo(escrowPda)).to.eq(null);
    });

    it("does not let a settled market go back to disputed", async () => {
      const a = base({ status: Status.DISPUTED, disputeCount: 3, riskBps: OPEN_DISPUTE_RISK_BPS, observedAt: now() });
      await expectError(post(signAttestation(a, attestor.secretKey)), "AlreadySettled");
    });
  });

  it("enforces the cooling window right after settlement", async () => {
    const key = sha256("demo:fresh-settlement");
    const t = now() - 5;
    await post(
      signAttestation(
        { marketKey: key, status: Status.SETTLED, disputeCount: 1, settledDifferently: 1, riskBps: 0, settledAt: t, observedAt: t, evidenceHash: sha256("x") },
        attestor.secretKey
      )
    );
    await expectError(
      program.methods.checkSettlement().accountsPartial({ config: configPda, marketRisk: riskPda(key) }).rpc(),
      "CoolingPeriod"
    );
  });

  it("lets only the admin rotate the attestor", async () => {
    const other = Keypair.generate();
    await expectError(
      program.methods
        .updateConfig(other.publicKey, new anchor.BN(COOLING_SECS))
        .accountsPartial({ admin: other.publicKey, config: configPda })
        .signers([other])
        .rpc(),
      "ConstraintHasOne"
    );
  });
});
