# Car certificates: switching from Devnet to Mainnet

Cars are certificates on Solana **Devnet** (D-09). Moving to **Mainnet** is a configuration change in the API's environment, plus everything below. Do it only after legal review (Phase 12) and the security review.

## Before

1. **A new authority key for Mainnet.** Never reuse the Devnet key: it has been in local `.env` files and chats. Generate it offline, keep the only copy in a password manager and in Render's environment (`CHAIN_AUTHORITY_SECRET` on `fr33world-api`), and write down who can reach it.
2. **Fund the fee payer.** The authority pays every mint and transfer: about 0.003 SOL a car to mint (rent and fee), a fraction of that to transfer. Fund it for the next month's sales, and add an alert below 0.5 SOL.
3. **A paid RPC.** Public Mainnet RPC rate-limits hard. Set `SOLANA_RPC_URL` to a paid provider (Helius, Triton, QuickNode).
4. **Metadata host.** Certificates point at `https://<client>/nft/cars/<model>.json`. Mainnet assets are permanent: put the metadata on the final domain first.
5. **Security review** of `apps/api/src/chain.ts`, `apps/api/src/market.ts` and `packages/chain`: the authority holds the freeze and transfer delegates for every car.
6. **Legal:** whether tradable on-chain items are allowed in each launch country (D-22), and the Terms.

## The switch

1. Render → `fr33world-api` → Environment: `SOLANA_CLUSTER=mainnet-beta`, `CHAIN_ALLOW_MAINNET=yes`, `SOLANA_RPC_URL=<paid>`, `CHAIN_AUTHORITY_SECRET=<new key>`. Save (it redeploys).
2. The API log says `car certificates on mainnet-beta: <authority>`. Check it's the new key.
3. Existing Devnet certificates stay on Devnet. Re-queue the cars that should be on Mainnet: `update car_chain set status = 'mint', asset = null, attempts = 0, next_at = now()`.
4. Watch `/v1/admin/economy` alerts (kind `chain`) for the first day: reconciliation flags any car whose chain owner differs from the game.

## Rolling back

Unset `CHAIN_AUTHORITY_SECRET`: the queue stops and waits; the game keeps working. Certificates already minted stay where they are.
