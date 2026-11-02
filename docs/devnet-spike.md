# Devnet spike: car ownership on Solana

Phase 0 test of the on-chain car design (decisions D-09 and D-22), run on 2026-10-28 with `pnpm --filter @fr33world/chain spike`.

## Design under test

- Each car is a **Metaplex Core asset** in the "Los Soles Motors" collection, minted into the owner's wallet (their embedded Privy wallet).
- It is minted **frozen** by a _permanent freeze delegate_ the game holds, so the owner can't sell or send it outside the game.
- The game also holds a _permanent transfer delegate_, which overrides the freeze: when an in-game sale settles in `$`, the game moves the car to the buyer.
- Both permanent plugins can only be set at creation, and the owner can't remove them.
- **Retries are safe.** The asset address is derived from the game authority's secret and the car's id, so a retried mint finds the first asset instead of minting a second car. A transfer to someone who already owns the car does nothing.

Code: [packages/chain](../packages/chain/src/) (`CarRegistry`).

## Result

| Check                                                        | Result |
| ------------------------------------------------------------ | ------ |
| Minted to the player                                         | PASS   |
| Frozen in their wallet                                       | PASS   |
| The game holds both permanent delegates                      | PASS   |
| The owner's own transfer is refused ("Invalid Authority")    | PASS   |
| Control: the same car without the freeze, the owner can send | PASS   |
| The game moves the car to another player                     | PASS   |
| Still frozen for the new owner                               | PASS   |
| Retried mint changes nothing (same address)                  | PASS   |
| Retried transfer changes nothing                             | PASS   |

**Where it ran:** first on a local Solana validator with the Metaplex Core program cloned from Devnet, then **on Devnet itself** (2026-10-28, after the owner funded the game authority from https://faucet.solana.com; Devnet's automatic RPC faucet is closed). Same 9/9 on both.

Devnet run:

- Car asset: [2oPnMjJK…TGDT](https://explorer.solana.com/address/2oPnMjJKFkftKJHPhpvVvoHKoFdANes4okMf58zyGTDT?cluster=devnet)
- Mint: [transaction](https://explorer.solana.com/tx/wfUsNZHyno4t5WpW1zC3ma9H9fKR4kES8UMgk3LruWpzZ2aoWdq8LE7afrUQH4zR9XHhSodTEX1sXcTf94WTLWJ?cluster=devnet)
- Game transfer to the buyer: [transaction](https://explorer.solana.com/tx/4d8azKz1Cg93oEmKaVEBmSdF9Chc2bVqbtP4Edkrtnw52GTV8rFDuftxgY1NLsDz1PcTzGr8eruKTPEH2gwvzN2?cluster=devnet)
- Collection "Los Soles Motors": [2QpFJP7j…dKQA](https://explorer.solana.com/address/2QpFJP7jqFWi1Kp99BnvotEN9Hdk5qoZobi5n3tbdKQA?cluster=devnet)
- Game authority: `6i7erWz6MuCWeCmUvw7J4qLTwu7EzCsAQyt86TupBasU`

To rerun on a local validator instead:

```bash
solana-test-validator --reset --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d --url https://api.devnet.solana.com
SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm --filter @fr33world/chain spike
```

**Cost:** the game paid about 0.0081 SOL on Devnet for two cars and two transfers. A car costs about 0.004 SOL to create, almost all of it rent (a refundable deposit held by the asset account); a transfer costs only the network fee. The game pays all of it; players never need SOL.

## What it means for Phase 11

- The trade flow needs no player signature on-chain: the game settles `$` in its ledger, then moves the certificate. Players never see a wallet prompt (web2-simple UX, owner's requirement).
- The chain worker can retry every mint and transfer blindly after a timeout.
- Mainnet is a configuration switch (`SOLANA_CLUSTER=mainnet-beta` plus `CHAIN_ALLOW_MAINNET=yes`) plus the go-live checklist: key custody for the authority, a funded fee payer, and a security review.
- Open: what players see if they open their wallet elsewhere (the asset shows, marked frozen), and whether to let a car leave the game later (thaw), which is the deferred "external sales" decision.
