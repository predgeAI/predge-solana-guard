//! Predge Settlement Guard
//!
//! An on-chain registry of signed settlement-risk attestations for prediction
//! markets, plus a settlement gate that any Solana market, perps venue or
//! escrow can call before it settles on an outcome.
//!
//! Flow:
//! 1. Predge observes the resolution path of a reference market (today:
//!    Polymarket questions settled through UMA on Polygon) and signs a compact
//!    97-byte attestation with its ed25519 key.
//! 2. Anyone (a relayer, a keeper, the market itself) submits that
//!    attestation in a transaction that also carries a native Ed25519 program
//!    instruction. This program reads the instructions sysvar and checks that
//!    the signature was made by the configured attestor over exactly these
//!    bytes. No trust in the relayer is needed.
//! 3. The latest state per market lives in a `MarketRisk` PDA. Consumers
//!    either read it directly or CPI into `check_settlement`, which fails
//!    unless the reference market is settled and past a cooling window.
//! 4. `open_escrow` / `release_escrow` show the gate in use: funds stay locked
//!    while the reference market is proposed, disputed or escalated to a vote.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};

/// Native Ed25519 signature-verification program.
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

declare_id!("B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush");

/// Domain separator that prefixes every signed attestation.
pub const DOMAIN: &[u8; 12] = b"PREDGE-SR-v1";
/// Length of the signed message: 12 + 32 + 1 + 1 + 1 + 2 + 8 + 8 + 32.
pub const MESSAGE_LEN: usize = 97;
/// Attestations dated further than this into the future are rejected.
pub const MAX_CLOCK_DRIFT_SECS: i64 = 300;

pub mod status {
    pub const UNKNOWN: u8 = 0;
    /// An outcome was proposed to the oracle and is in its challenge window.
    pub const PROPOSED: u8 = 1;
    /// The proposal was disputed once; the question was reset.
    pub const DISPUTED: u8 = 2;
    /// Disputed twice or more: the outcome goes to a UMA token-holder vote.
    pub const ESCALATED: u8 = 3;
    /// Resolved on-chain on the reference venue.
    pub const SETTLED: u8 = 4;
    pub const MAX: u8 = 4;
}

#[program]
pub mod predge_guard {
    use super::*;

    /// Create the singleton config: who may sign attestations and how long a
    /// settled market must age before consumers treat it as final.
    pub fn initialize(ctx: Context<Initialize>, attestor: Pubkey, cooling_secs: i64) -> Result<()> {
        require!(cooling_secs >= 0, GuardError::InvalidConfig);
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.attestor = attestor;
        cfg.cooling_secs = cooling_secs;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Rotate the attestor key or change the cooling window. Admin only.
    pub fn update_config(ctx: Context<UpdateConfig>, attestor: Pubkey, cooling_secs: i64) -> Result<()> {
        require!(cooling_secs >= 0, GuardError::InvalidConfig);
        let cfg = &mut ctx.accounts.config;
        cfg.attestor = attestor;
        cfg.cooling_secs = cooling_secs;
        Ok(())
    }

    /// Record a signed attestation. Permissionless: validity comes from the
    /// ed25519 signature, checked through the instructions sysvar.
    pub fn post_attestation(ctx: Context<PostAttestation>, att: Attestation) -> Result<()> {
        require!(
            att.status >= status::PROPOSED && att.status <= status::MAX,
            GuardError::InvalidStatus
        );
        require!(att.risk_bps <= 10_000, GuardError::InvalidRisk);
        require!(att.settled_differently <= 1, GuardError::InvalidStatus);
        if att.status == status::SETTLED {
            require!(att.settled_at > 0, GuardError::InvalidStatus);
        }

        let clock = Clock::get()?;
        require!(
            att.observed_at <= clock.unix_timestamp + MAX_CLOCK_DRIFT_SECS,
            GuardError::FutureAttestation
        );

        let message = att.message();
        verify_ed25519_ix(
            &ctx.accounts.instructions_sysvar,
            &ctx.accounts.config.attestor.to_bytes(),
            &message,
        )?;

        let risk = &mut ctx.accounts.market_risk;
        if risk.observed_at != 0 {
            // Monotonic: an older or equal observation never overwrites a newer one.
            require!(att.observed_at > risk.observed_at, GuardError::StaleAttestation);
            // Once settled, the record is final. A later attestation may only restate settlement.
            if risk.status == status::SETTLED {
                require!(att.status == status::SETTLED, GuardError::AlreadySettled);
            }
        }

        risk.market_key = att.market_key;
        risk.status = att.status;
        risk.dispute_count = att.dispute_count;
        risk.settled_differently = att.settled_differently;
        risk.risk_bps = att.risk_bps;
        risk.settled_at = att.settled_at;
        risk.observed_at = att.observed_at;
        risk.evidence_hash = att.evidence_hash;
        risk.updated_slot = clock.slot;
        risk.bump = ctx.bumps.market_risk;

        emit!(AttestationPosted {
            market_key: att.market_key,
            status: att.status,
            dispute_count: att.dispute_count,
            risk_bps: att.risk_bps,
            observed_at: att.observed_at,
            evidence_hash: att.evidence_hash,
        });
        Ok(())
    }

    /// Settlement gate. Succeeds only if the reference market is settled and
    /// the cooling window has passed. Meant to be called via CPI by any
    /// program that settles on the reference outcome.
    pub fn check_settlement(ctx: Context<CheckSettlement>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        assert_final(&ctx.accounts.market_risk, ctx.accounts.config.cooling_secs, now)
    }

    /// Demo consumer: lock lamports for a beneficiary until the reference
    /// market behind `market_key` is final.
    pub fn open_escrow(
        ctx: Context<OpenEscrow>,
        escrow_id: u64,
        market_key: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, GuardError::InvalidAmount);
        let escrow = &mut ctx.accounts.escrow;
        escrow.depositor = ctx.accounts.depositor.key();
        escrow.beneficiary = ctx.accounts.beneficiary.key();
        escrow.market_key = market_key;
        escrow.amount = amount;
        escrow.escrow_id = escrow_id;
        escrow.bump = ctx.bumps.escrow;

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    /// Release the escrow to the beneficiary. Fails with a specific error
    /// while the reference market is still at risk.
    pub fn release_escrow(ctx: Context<ReleaseEscrow>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        assert_final(&ctx.accounts.market_risk, ctx.accounts.config.cooling_secs, now)?;
        emit!(EscrowReleased {
            escrow: ctx.accounts.escrow.key(),
            market_key: ctx.accounts.escrow.market_key,
            amount: ctx.accounts.escrow.amount,
        });
        // `close = beneficiary` moves the deposit plus rent to the beneficiary.
        Ok(())
    }
}

/// Final means: settled on the reference venue and older than the cooling window.
pub fn assert_final(risk: &MarketRisk, cooling_secs: i64, now: i64) -> Result<()> {
    match risk.status {
        status::SETTLED => {
            require!(
                now >= risk.settled_at.saturating_add(cooling_secs),
                GuardError::CoolingPeriod
            );
            Ok(())
        }
        status::DISPUTED => err!(GuardError::MarketDisputed),
        status::ESCALATED => err!(GuardError::MarketEscalated),
        _ => err!(GuardError::SettlementNotFinal),
    }
}

/// Verify that the instruction right before this one is a native Ed25519
/// signature check, by `expected_pubkey`, over exactly `expected_msg`, with
/// all data inline in that instruction.
fn verify_ed25519_ix(
    ix_sysvar: &AccountInfo,
    expected_pubkey: &[u8; 32],
    expected_msg: &[u8],
) -> Result<()> {
    let current = load_current_index_checked(ix_sysvar)? as usize;
    require!(current > 0, GuardError::MissingEd25519Ix);
    let ix = load_instruction_at_checked(current - 1, ix_sysvar)?;
    require_keys_eq!(ix.program_id, ED25519_PROGRAM_ID, GuardError::MissingEd25519Ix);
    require!(ix.accounts.is_empty(), GuardError::BadEd25519Ix);

    let d = &ix.data;
    // Header: num_signatures (u8), padding (u8), then one 14-byte offsets struct.
    require!(d.len() >= 16, GuardError::BadEd25519Ix);
    require!(d[0] == 1, GuardError::BadEd25519Ix);
    let rd = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]);
    let sig_off = rd(2) as usize;
    let sig_ix = rd(4);
    let pk_off = rd(6) as usize;
    let pk_ix = rd(8);
    let msg_off = rd(10) as usize;
    let msg_len = rd(12) as usize;
    let msg_ix = rd(14);
    // u16::MAX means "data lives in this same Ed25519 instruction".
    require!(
        sig_ix == u16::MAX && pk_ix == u16::MAX && msg_ix == u16::MAX,
        GuardError::BadEd25519Ix
    );
    require!(sig_off.checked_add(64).map_or(false, |e| e <= d.len()), GuardError::BadEd25519Ix);
    require!(pk_off.checked_add(32).map_or(false, |e| e <= d.len()), GuardError::BadEd25519Ix);
    require!(
        msg_off.checked_add(msg_len).map_or(false, |e| e <= d.len()),
        GuardError::BadEd25519Ix
    );

    require!(&d[pk_off..pk_off + 32] == expected_pubkey, GuardError::WrongAttestor);
    require!(&d[msg_off..msg_off + msg_len] == expected_msg, GuardError::MessageMismatch);
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Attestation {
    /// sha256("polymarket:" + UMA questionID hex, lowercase, 0x-prefixed).
    pub market_key: [u8; 32],
    pub status: u8,
    pub dispute_count: u8,
    /// 1 if the settled outcome differs from the last disputed proposal.
    pub settled_differently: u8,
    /// Attestor's estimate, in basis points, that the currently proposed
    /// outcome does not stand. 0 once settled.
    pub risk_bps: u16,
    pub settled_at: i64,
    pub observed_at: i64,
    /// sha256 of the canonical bytes of the off-chain signed evidence pack.
    pub evidence_hash: [u8; 32],
}

impl Attestation {
    /// Exact bytes the attestor signs. Fixed layout, little-endian integers.
    pub fn message(&self) -> [u8; MESSAGE_LEN] {
        let mut m = [0u8; MESSAGE_LEN];
        m[0..12].copy_from_slice(DOMAIN);
        m[12..44].copy_from_slice(&self.market_key);
        m[44] = self.status;
        m[45] = self.dispute_count;
        m[46] = self.settled_differently;
        m[47..49].copy_from_slice(&self.risk_bps.to_le_bytes());
        m[49..57].copy_from_slice(&self.settled_at.to_le_bytes());
        m[57..65].copy_from_slice(&self.observed_at.to_le_bytes());
        m[65..97].copy_from_slice(&self.evidence_hash);
        m
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub attestor: Pubkey,
    pub cooling_secs: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MarketRisk {
    pub market_key: [u8; 32],
    pub status: u8,
    pub dispute_count: u8,
    pub settled_differently: u8,
    pub risk_bps: u16,
    pub settled_at: i64,
    pub observed_at: i64,
    pub evidence_hash: [u8; 32],
    pub updated_slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub depositor: Pubkey,
    pub beneficiary: Pubkey,
    pub market_key: [u8; 32],
    pub amount: u64,
    pub escrow_id: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(att: Attestation)]
pub struct PostAttestation<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + MarketRisk::INIT_SPACE,
        seeds = [b"risk", att.market_key.as_ref()],
        bump
    )]
    pub market_risk: Account<'info, MarketRisk>,
    /// CHECK: address-constrained to the instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CheckSettlement<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"risk", market_risk.market_key.as_ref()], bump = market_risk.bump)]
    pub market_risk: Account<'info, MarketRisk>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct OpenEscrow<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// CHECK: any account may be the beneficiary.
    pub beneficiary: UncheckedAccount<'info>,
    #[account(
        init,
        payer = depositor,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", depositor.key().as_ref(), &escrow_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseEscrow<'info> {
    /// Anyone may trigger release; funds can only go to the beneficiary.
    pub caller: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"risk", escrow.market_key.as_ref()], bump = market_risk.bump)]
    pub market_risk: Account<'info, MarketRisk>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.depositor.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump,
        has_one = beneficiary,
        close = beneficiary
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: checked by `has_one` on the escrow.
    #[account(mut)]
    pub beneficiary: UncheckedAccount<'info>,
}

#[event]
pub struct AttestationPosted {
    pub market_key: [u8; 32],
    pub status: u8,
    pub dispute_count: u8,
    pub risk_bps: u16,
    pub observed_at: i64,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct EscrowReleased {
    pub escrow: Pubkey,
    pub market_key: [u8; 32],
    pub amount: u64,
}

#[error_code]
pub enum GuardError {
    #[msg("Invalid config")]
    InvalidConfig,
    #[msg("Invalid status")]
    InvalidStatus,
    #[msg("risk_bps must be at most 10000")]
    InvalidRisk,
    #[msg("Attestation is dated in the future")]
    FutureAttestation,
    #[msg("Attestation is not newer than the stored one")]
    StaleAttestation,
    #[msg("Market already settled; only a settled restatement is accepted")]
    AlreadySettled,
    #[msg("Expected an Ed25519 signature instruction right before this one")]
    MissingEd25519Ix,
    #[msg("Malformed Ed25519 instruction")]
    BadEd25519Ix,
    #[msg("Signature is not from the configured attestor")]
    WrongAttestor,
    #[msg("Signed message does not match the attestation")]
    MessageMismatch,
    #[msg("Reference market is not settled yet")]
    SettlementNotFinal,
    #[msg("Reference market is disputed")]
    MarketDisputed,
    #[msg("Reference market is escalated to a UMA vote")]
    MarketEscalated,
    #[msg("Reference market settled but the cooling window has not passed")]
    CoolingPeriod,
    #[msg("Amount must be positive")]
    InvalidAmount,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(status: u8) -> Attestation {
        Attestation {
            market_key: [7u8; 32],
            status,
            dispute_count: 2,
            settled_differently: 0,
            risk_bps: 3354,
            settled_at: 1_780_533_259,
            observed_at: 1_780_533_300,
            evidence_hash: [9u8; 32],
        }
    }

    #[test]
    fn message_layout_is_fixed() {
        let m = att(status::SETTLED).message();
        assert_eq!(m.len(), 97);
        assert_eq!(&m[0..12], b"PREDGE-SR-v1");
        assert_eq!(m[44], status::SETTLED);
        assert_eq!(u16::from_le_bytes([m[47], m[48]]), 3354);
        assert_eq!(&m[65..97], &[9u8; 32]);
    }

    fn risk(status: u8, settled_at: i64) -> MarketRisk {
        MarketRisk {
            market_key: [0; 32],
            status,
            dispute_count: 0,
            settled_differently: 0,
            risk_bps: 0,
            settled_at,
            observed_at: 1,
            evidence_hash: [0; 32],
            updated_slot: 0,
            bump: 0,
        }
    }

    #[test]
    fn gate_blocks_until_final() {
        assert!(assert_final(&risk(status::PROPOSED, 0), 3600, 10_000).is_err());
        assert!(assert_final(&risk(status::DISPUTED, 0), 3600, 10_000).is_err());
        assert!(assert_final(&risk(status::ESCALATED, 0), 3600, 10_000).is_err());
        assert!(assert_final(&risk(status::SETTLED, 9_000), 3600, 10_000).is_err());
        assert!(assert_final(&risk(status::SETTLED, 6_400), 3600, 10_000).is_ok());
    }
}
