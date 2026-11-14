# fr33world: cars you truly own, in a city that runs itself on NEAR

**Built at NEAR HACKATHON.** Tracks: Games With Real Economies, Autonomous Business, Agent Economy, AI Security & Defense.

fr33world is a multiplayer open-world city game in the browser. Like any city game it has its own play money, `$`, earned from jobs and spent on everything. For this hackathon, what players buy to keep became theirs for real: every car bought at the dealership is minted to the buyer's own NEAR wallet, its title deed. Players sell cars to each other for `$` or USDC, and the buyer chooses. The dealership, Sol Motors, is a business that runs itself, with its own wallet and an AI that trades within limits written into its contract.

**The problem:** in GTA Online or any other city game, players own nothing. A ban, a wipe or a shutdown and the garage is gone. "AI agents with wallets" usually means trusting an AI with a key. Here the cars are provably the player's, and the AI can't overspend even if it's wrong or attacked.

## Disclosure (hackathon rules Q-001 to Q-004)

fr33world existed before this work, as a game with a Solana integration. **Only the NEAR work is the submission.** Tag `pre-hackathon` marks the game before it, and Solana was removed after it. [The diff between `pre-hackathon` and `hackathon-submission`](https://github.com/fr33world/fr33world-near/compare/pre-hackathon...hackathon-submission) holds the NEAR integration, which is what to judge. That diff also holds ordinary game work done in the same weeks, which is not part of the submission and touches no USDC: faction join points, uniforms, police patrols, 911 screens, passengers, daily rewards, private messages, garages, the game screen and accessory fixes. An earlier design in the same diff ran a food supply chain on USDC; it is switched off (`FOOD_CHAIN_USDC` in apps/api/src/business.ts) and kept for the record.

## How it works

- **`$` is the game's money.** The game sells everything for it: cars, fuel, food, fines. No code turns `$` into USDC.
- **Cars are NEP-171 tokens** on [the cars contract](contracts/cars/src/lib.rs), minted to the buyer's own NEAR wallet (a Privy embedded wallet, signed on their device). They show in any NEAR wallet, can be sent to any account, and stay the player's even if the game bans them. The garage follows the chain: a car sent or sold on chain moves to the player whose wallet holds it, or leaves every garage while an unlinked wallet holds it.
- **The buyer chooses the currency.** A seller asks `$`, USDC or both.
  - **USDC sale:** the buyer's own USDC goes to the contract, which in one step moves the car, pays the seller and sends Sol Motors 5%.
  - **`$` sale:** the seller first signs `offer_to_game` for that one car. The game then hands it to whoever pays the `$` price, inside the same database transaction as the payment: if the chain refuses, no `$` moves. The game can move no car that wasn't offered to it.
- **Homes work the same way.** The 36 villas in the hills are bought for `$` at their front door, one owner each, and each is minted to the buyer's wallet as a NEP-171 token on the homes contract: the cars contract's code, deployed again as "fr33world homes" (`homes.fr33world.testnet`). Its picture in a wallet is that villa, photographed in the game.
- **New and just-sold cars are locked** (1 hour on testnet, a day on mainnet), so farming cars to cash them out at once doesn't pay. At most 3 listings and 3 USDC sales a day per player.
- **USDC into `$`, one way:** 1 USDC buys $5,000, at most 50 USDC a week. The USDC goes to Sol Motors' wallet, and `$` is paid only once the chain shows it arrived. There's no way back from `$` to USDC.
- **Sol Motors runs itself.** All its USDC comes from players: the 5% cut and the top-ups. It has three locks on spending:
  1. **The AI proposes:** NEAR AI Cloud picks which car listed far under its worth to buy, and the resale price. It sees only numbers, never player text, so it can't be prompt-injected.
  2. **Rules clamp:** [shared BUYBACK](packages/shared/src/assets.ts) allows only cars at most 60% of their worth, half the free balance at most, three cars held, and resale at 90 to 120% of worth.
  3. **The [wallet contract](contracts/business-wallet/src/lib.rs) enforces:** it can pay only the cars contract, at most 25 USDC a payment and 100 a day. It has no withdraw method, and a new payee waits a day.
- **Test USDC for trying it:** on testnet the wallet's "Get 5 test USDC" asks the public community faucet (`v2.faucet.nonofficial.testnet`) to pay the player's own account. The game adds none of its own.

## Try it

Needs Node 24, pnpm, Rust with cargo-near, and PostgreSQL. No NEAR account is needed for steps 1 to 3.

1. **Do:** `cd contracts/cars && cargo test`, then `cd ../business-wallet && cargo test`. **See:** 36 and 31 tests pass, among them: the minter and admin can't move a player's car, a `$` sale works only for an offered car and only once, a wrong amount is refunded, and a stolen admin key can't pay itself.
2. **Do:** `pnpm install && pnpm db:start && createdb fr33world_test && pnpm --filter @fr33world/api exec vitest run src/cars.test.ts src/homes.test.ts src/dealer.test.ts src/usdc.test.ts`. **See:** the economy's rules against a stand-in chain, all passing: deeds minted once, a home sold to one buyer only (two at the same moment: one gets it, the other pays nothing), the garage following the chain, both currencies, the handover undone if the chain refuses, the top-up's cap, and the AI's answers cut to the rules.
3. **Do:** read the live contracts:
   `curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"sol-motors.fr33world.testnet","method_name":"summary","args_base64":"e30="}}'`
   **See:** a result whose bytes decode to Sol Motors' balance, limits and its one approved payee, `cars.fr33world.testnet`. Or open [the cars contract on NearBlocks](https://testnet.nearblocks.io/address/cars.fr33world.testnet) to see the mints, sales and Sol Motors' buybacks.
4. **Do (needs testnet keys in `.env`):** `pnpm --filter @fr33world/api economy:live`. **See:** the whole story through the real API routes and the real chain, each payment with a NearBlocks link, ending in `All good.`:
   - Ava buys a Sedan with `$` and its deed is minted to her wallet.
   - Ben tops up `$` with USDC.
   - Ava lists the Sedan for `$` and USDC, and Ben pays USDC: the car moves, Ava gets 95% and Sol Motors 5%.
   - Ben resells it for `$`, and it's handed over on chain.
   - Ava sends it to a wallet outside the game, and it leaves her garage.
   - Sol Motors' AI buys a second Sedan listed at 4 USDC (worth 7) and relists it near its worth.

   Only Privy is stood in for, by a local key signing the same hash.

5. **Do:** open https://fr33worldgame.xyz/economy.html. **See:** Sol Motors' balance, limits and payee read live from the chain, and the number of deeds minted. Its lists of AI decisions (each with its reason) and car sales fill as players trade in the hosted game; at submission they were still empty there, because the AI's trades so far ran through step 4's test runs. Those trades are real testnet transactions: [Sol Motors' account on NearBlocks](https://testnet.nearblocks.io/address/sol-motors.fr33world.testnet) shows it paying for the Sedan `car-4-b9b3bd` at 4 USDC (`on_order_paid`) and relisting it at 7.70 (`list_car`); a player has since bought it.

## Built with (Q-005)

No hackathon template or starter was used. The NEAR work uses:

- **Contracts:** Rust with [near-sdk](https://crates.io/crates/near-sdk) 5.30 and [near-contract-standards](https://crates.io/crates/near-contract-standards) 5.30 (NEP-171 core, enumeration and metadata), built with cargo-near.
- **Chain access:** [near-api-js](https://www.npmjs.com/package/near-api-js) 7.4, with FastNEAR's public testnet RPC.
- **Player wallets:** [Privy](https://privy.io) embedded NEAR wallets (`@privy-io/react-auth`, `@privy-io/node`), signed on the player's device. The game tops up their gas, so players need no NEAR of their own.
- **AI:** [NEAR AI Cloud](https://cloud.near.ai) (OpenAI-compatible), model `deepseek-ai/DeepSeek-V4.1-Flash-1017`.
- **Test token and faucet:** `usdc.fakes.testnet` and `v2.faucet.nonofficial.testnet`, both community-run.
- **Around it, from before the hackathon:** Fastify and PostgreSQL (API), Three.js, React and Vite (client), Cloudflare Workers and Render (hosting).

## Other submissions (Q-015)

The people behind fr33world submit no other project to this hackathon.

## Honest limits

- This public copy leaves out the character animation files, whose licence doesn't allow sharing them on their own. Steps 1 to 4 don't need them. To play with animations, use the hosted game.
- It runs on NEAR Testnet with `usdc.fakes.testnet`, a community test token from the public faucet, not Circle's USDC. Test USDC has no value. Mainnet needs everything in [docs/mainnet-checklist.md](docs/mainnet-checklist.md).
- No real Privy login has signed one of these transactions yet. Every flow ran on testnet through the real API routes, signed by a local key making the same raw signature Privy's embedded wallet makes.
- Sol Motors' operator key can list a car the dealership holds at any price within the contract's range, so a stolen operator key could sell a held car cheaply. It can't move money or other players' cars.
- Contracts are unaudited. Other businesses (shops, enterprises) are designed to follow Sol Motors' pattern but aren't built; only cars and the hill villas are owned on NEAR.

---

# fr33world: Horizon Block prototype

A browser 3D multiplayer roleplay game set in **Los Soles**, an original LA-inspired city. This is the M0 prototype (see [docs/technical-plan.md](docs/technical-plan.md) §13).

## Run it

Requirements: Node 24+, pnpm 11.

```bash
pnpm install
pnpm db:start     # local PostgreSQL (native, no Docker); again after every restart of the Mac
pnpm dev          # world server :7400, game API :7410, client :5173 (watch mode)
pnpm dev:voice    # optional, in another terminal: local LiveKit for proximity voice
```

After pulling changes that add a service or a `.env` value, stop `pnpm dev` (Ctrl+C) and start it again: it only picks those up on start.

Requirements also include PostgreSQL 18 (Homebrew `postgresql@18`) with databases `fr33world_dev` and `fr33world_test` (`createdb` each once). The API applies its migrations on start.

Secrets live in `.env` at the repo root (git-ignored); copy `.env.example` to start. Progress and the full roadmap are in [track.md](track.md).

Open http://localhost:5173. To play from a phone on the same Wi-Fi, open `http://<this computer's LAN IP>:5173`. Vite prints it as "Network". The client connects to the world server on the same host, port 7400. Phones on that plain-http address play without a login: Privy only works over HTTPS (or on localhost).

The world server also answers plain HTTP on its port: `GET /health` and `GET /status` (players online, capacity, game time). Try http://localhost:7400/status.

| URL option                  | Effect                                    |
| --------------------------- | ----------------------------------------- |
| `?offline`                  | Play without the server (cars still work) |
| `?q=low\|medium\|high`      | Force a quality tier                      |
| `?t=19.5`                   | Freeze the clock at an hour (19:30)       |
| `?name=Ada`                 | Player name                               |
| `?server=ws://host:7400/ws` | Another world server                      |
| `?fly&cam=x,y,z,tx,ty,tz`   | Free camera for screenshots               |
| `?perf=0`                   | Hide the performance overlay              |

Controls:

- **Desktop:** WASD to move, click and use the mouse to look, Space to jump, Shift to walk, E to get in or out of a car, Q to draw or holster the pistol, right mouse to aim, left mouse to fire.
- **Driving (desktop):** W/S for gas and brake, A/D to steer, Space for the handbrake.
- **Touch:** a joystick on the left half of the screen, drag on the right half to look, plus the Jump, Gun, Fire, Gas and Brake buttons.

## Playtest with bots

Run `pnpm dev` in one terminal and `pnpm bots` in another. 100 bots join your running world server and mill around the spawn plaza; stop them with Ctrl+C.

```bash
BOTS=150 SCENARIO=spread pnpm bots    # more bots, spread over the streets
```

Against the deployed server: `SERVER_URL=wss://fr33world-world.onrender.com/ws BOTS=20 pnpm bots`. Keep it small and short there: the free plan allows 50 players, and bots use the month's traffic allowance like real players.

## Deploy

**Client (Cloudflare):** `pnpm deploy:cloudflare` builds the client and uploads it with Wrangler (needs `npx wrangler login` once). It's live at https://fr33worldgame.xyz (the old https://fr33world.fr33world-client.workers.dev link still works). The build points at `wss://fr33world-world.onrender.com/ws`; set `VITE_WORLD_URL` to override. Cloudflare serves the files without metered traffic.

**World server (Render):** [render.yaml](render.yaml) is a Render Blueprint for the free plan: the world server as a web service (WebSocket at `/ws` plus the HTTP API). In the Render dashboard: **New → Blueprint**, pick the repo, then enter `PRIVY_APP_ID` and `PRIVY_APP_SECRET` when asked.

Add the client's address to the Privy dashboard's allowed domains.

The free plan sleeps the world server after 15 minutes with nobody connected. The client wakes it (about a minute) and says so on the login screen. Its limits and what they mean for players are in [track.md](track.md) under Hosting.

## Voice (LiveKit)

Locally: `livekit-server --dev` (installed with Homebrew); `.env` already points at it. Online, voice runs on LiveKit Cloud:

1. Sign up at https://cloud.livekit.io and create a project (e.g. `fr33world`).
2. Settings → API Keys → Create key. Copy the **WebSocket URL** (`wss://<project>.livekit.cloud`), the **API key** and the **API secret** (shown once).
3. Render → `fr33world-world` → Environment: set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, then save (it redeploys).

The world server then gives every player a voice pass; the free Build plan allows 5,000 participant-minutes a month.

## Asset pipeline

Models ship with KTX2 textures (Basis Universal), which stay compressed on the GPU: a 2048² texture takes about 3 MB of video memory instead of 22 MB as WebP. That is what lets crowds run on phones.

- `node scripts/assets/optimize.mjs [glb ...]` converts a model's textures in place (default: all characters). Colour textures use ETC1S and normal maps UASTC, within budgets per detail level. Meshes, skins and animations are untouched.
- `node scripts/assets/inspect-skins.mjs <glb ...>` lists skins and bound meshes, to check a pass kept characters animatable.
- **Needs KTX-Software 4.3+.** On this Mac it's 4.4.2, unpacked (no installer, no admin password) into `~/.local/ktx-4.4.2/{bin,lib}` from the signed `KTX-Software-4.4.2-Darwin-x86_64.pkg` with `pkgutil --expand-full`. Elsewhere, install the release from https://github.com/KhronosGroup/KTX-Software/releases or set `KTX_HOME`.
- The client decodes with three's KTX2 loader. The Basis transcoder is in `apps/client/public/basis/`, copied from `three/examples/jsm/libs/basis/`; recopy it when upgrading three.

## Load test

`pnpm load` is the timed benchmark. It starts **its own** world server (port 7420 by default), so don't use it for playtesting.

```bash
BOTS=500 SCENARIO=spread TRANSPORT=uws pnpm load     # or SCENARIO=crowd, TRANSPORT=ws
node apps/world/src/load/bench-step.ts               # the world tick alone, no network
```

Results are in [docs/load-test-results.md](docs/load-test-results.md).

## Layout

| Path                   | What                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `packages/shared`      | World constants, the game clock, weapon stats                                    |
| `packages/protocol`    | Binary WebSocket protocol                                                        |
| `packages/city`        | Seeded Los Soles layout and collision, used by both server and client            |
| `apps/world`           | Authoritative world server: views, validation, seats, combat, load bots          |
| `apps/client`          | Three.js + React client (PWA later)                                              |
| `assets/registry.yaml` | Every shipped asset with its source and license; snapshots in `assets/licenses/` |
| `scripts/`             | Asset fetching (Poly Haven) and headless screenshots                             |

## Checks

```bash
pnpm test && pnpm typecheck && pnpm lint
```
