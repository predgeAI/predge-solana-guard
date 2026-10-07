//! Example consumer of Predge Settlement Guard.
//!
//! A minimal settlement vault: a depositor locks lamports for a beneficiary
//! against a reference prediction market. Before any lamport leaves the vault,
//! `release` makes one CPI call into `predge_guard::check_settlement`. If the
//! reference market is still proposed, disputed, escalated to a UMA vote, or
//! inside the cooling window, the CPI fails and the whole transaction reverts
//! with the guard's error (`SettlementNotFinal`, `MarketDisputed`,
//! `MarketEscalated`, `CoolingPeriod`).
//!
//! The integration is the `check_settlement` call in `release` plus two
//! read-only accounts (the guard's config PDA and the market's `MarketRisk`
//! PDA). Everything else here is ordinary vault code.

use anchor_lang::prelude::*;
use predge_guard::program::PredgeGuard;
use predge_guard::{Config as GuardConfig, MarketRisk};

declare_id!("6HSBJp8n4wM3RdjbbJY5XoKkBAH16HL8hEPbgk1RwUpg");

#[program]
pub mod example_consumer {
    use super::*;

    /// Lock `amount` lamports for `beneficiary` until the market behind
    /// `market_key` is final according to Predge Settlement Guard.
    pub fn deposit(ctx: Context<Deposit>, vault_id: u64, market_key: [u8; 32], amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);
        let vault = &mut ctx.accounts.vault;
        vault.depositor = ctx.accounts.depositor.key();
        vault.beneficiary = ctx.accounts.beneficiary.key();
        vault.market_key = market_key;
        vault.amount = amount;
        vault.vault_id = vault_id;
        vault.bump = ctx.bumps.vault;

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    /// Release the vault to the beneficiary, but only after the guard says the
    /// reference market is final.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        // The one-call integration: revert unless the reference market is final.
        predge_guard::cpi::check_settlement(CpiContext::new(
            ctx.accounts.predge_guard.to_account_info(),
            predge_guard::cpi::accounts::CheckSettlement {
                config: ctx.accounts.guard_config.to_account_info(),
                market_risk: ctx.accounts.market_risk.to_account_info(),
            },
        ))?;

        emit!(VaultReleased {
            vault: ctx.accounts.vault.key(),
            market_key: ctx.accounts.vault.market_key,
            amount: ctx.accounts.vault.amount,
        });
        // `close = beneficiary` sends the deposit plus rent to the beneficiary.
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub depositor: Pubkey,
    pub beneficiary: Pubkey,
    pub market_key: [u8; 32],
    pub amount: u64,
    pub vault_id: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// CHECK: any account may be the beneficiary.
    pub beneficiary: UncheckedAccount<'info>,
    #[account(
        init,
        payer = depositor,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", depositor.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    /// Anyone may trigger release; funds can only go to the beneficiary.
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.depositor.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = beneficiary,
        close = beneficiary
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: checked by `has_one` on the vault.
    #[account(mut)]
    pub beneficiary: UncheckedAccount<'info>,
    /// Predge Settlement Guard config PDA (owner-checked as a guard account;
    /// its seeds are re-checked inside `check_settlement`).
    pub guard_config: Account<'info, GuardConfig>,
    /// The reference market's risk record. It must be the one this vault
    /// was opened against; the guard re-checks its PDA seeds.
    #[account(constraint = market_risk.market_key == vault.market_key @ VaultError::WrongMarket)]
    pub market_risk: Account<'info, MarketRisk>,
    pub predge_guard: Program<'info, PredgeGuard>,
}

#[event]
pub struct VaultReleased {
    pub vault: Pubkey,
    pub market_key: [u8; 32],
    pub amount: u64,
}

#[error_code]
pub enum VaultError {
    #[msg("Amount must be positive")]
    InvalidAmount,
    #[msg("MarketRisk account is not for this vault's market")]
    WrongMarket,
}
