# The economy: switching from NEAR Testnet to Mainnet

The economy runs on NEAR **Testnet** (D-41), on `usdc.fakes.testnet`, a community test token. Moving to Mainnet means real money, so every item below is required first. It is not only a configuration change.

## Before

1. **Legal review.** Money transmission, tax on what players earn, sanctions, age and identity checks, and whether businesses that earn while their owner is away count as investments (D-45), for each country served. Terms and Privacy reviewed for real money.
2. **Outside contract audit** of `contracts/business-wallet` and `contracts/cars`. They hold real USDC and players' cars, and have not been audited.
3. **Keys.** New operator and admin keys, never reused from testnet. The admin key offline, ideally a multisig. The operator key in a key manager, not a plain environment variable.
4. **Lock the wallets:** `deploy.ts --lock` removes each business account's keys so its code can't change. Upgrades then mean new accounts.
5. **Paid hosting and database** (D-36), and a paid RPC.
6. **Gas for players.** Testnet gives each new player 0.08 NEAR. Mainnet should use a relayer (NEP-366) instead.
7. **Abuse limits** reviewed against real money: identity, job caps, and `$` payment limits that could feed outside sales of `$`.
8. **Cars and top-ups (owner, 2026-11-13).** Audit `contracts/cars` too. Lock cars for a day after minting and after each sale (shared CAR_ASSETS `lockHours.mainnet`). Decide the revenue split: on testnet every top-up's USDC goes to Sol Motors' wallet; on mainnet the owner asked for a share as the game's revenue, which needs its own account and a change to where `startTopup` pays. Real-money resale of cars bought with `$` lets play time be cashed out: review the caps (3 listings, 3 USDC sales a day, 50 USDC of top-ups a week) and anti-bot checks before opening it.

## The switch

Set `NEAR_NETWORK=mainnet`, `CHAIN_ALLOW_MAINNET=yes`, `NEAR_ROOT_ACCOUNT`, and `NEAR_USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (Circle's USDC on NEAR), then deploy new wallets. Watch `economy` alerts: reconciliation flags any wallet that disagrees with the game.

## Rolling back

Unset `NEAR_OPERATOR_KEY`: the worker stops and USDC routes say so. Players keep their USDC, which is in their own accounts.
