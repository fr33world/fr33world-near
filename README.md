# fr33world: a city whose businesses run themselves on NEAR

**Built at NEAR HACKATHON.** Tracks: Games With Real Economies, Autonomous Business, Agent Economy, AI Security & Defense.

fr33world is a multiplayer open-world life game in the browser. For this hackathon its shops became real businesses: each has its own NEAR account and wallet contract, watches its stock, reorders from its supplier, pays in USDC on chain, and hires players for deliveries, with nobody at the controls.

**The problem:** "NPC economies" are usually scripted, and "AI agents with wallets" usually means trusting an AI with a key. Here the money is real and verifiable, and the AI can't overspend even if it's wrong or attacked.

## Disclosure (hackathon rules Q-001 to Q-004)

fr33world existed before this work, as a game with a Solana integration. **Only the NEAR work is the submission.** Tag `pre-hackathon` marks the game before it, and Solana was removed after it. [The diff between `pre-hackathon` and `hackathon-submission`](https://github.com/fr33world/fr33world-near/compare/pre-hackathon...hackathon-submission) holds the NEAR integration, which is what to judge. That diff also holds ordinary game work done in the same weeks, which is not part of the submission and touches no USDC: faction join points, uniforms, police patrols, 911 screens, passengers, daily rewards, private messages and accessory fixes.

## How the money works

- **All USDC comes from players.** The game adds none: no treasury, no minting. Businesses start with stock and no cash, and their first USDC is a player's first purchase.
- **Test USDC for trying it:** on testnet the wallet's "Get 5 test USDC" asks the public community faucet (`v2.faucet.nonofficial.testnet`) to pay the player's own account directly. The game adds none of its own. Limits: once a day per game account and per wallet, only while the wallet holds under 5, 100 claims a day across all players ([`TEST_USDC`](packages/shared/src/business.ts)). There's no faucet on mainnet.
- **Goods and services only.** Nothing here is a wager.
- **Two currencies, no bridge.** In-game `$` is off chain. No code path turns `$` into USDC.
- **Players hold their own USDC** in a Privy NEAR wallet, signed on their device. The game can't move it.
- **Three locks on spending:** AI proposes, fixed rules validate, and [the wallet contract](contracts/business-wallet/src/lib.rs) enforces. The worker's key can only pay approved suppliers within per-payment and daily limits. There is no withdraw method, and a new supplier waits a day before it can be paid.
- **The AI sees only numbers,** never player text, so it can't be prompt-injected. Its answer is clamped to [limits in one readable file](packages/shared/src/business.ts).

## Try it

Needs Node 24, pnpm and PostgreSQL. No NEAR account is needed for steps 1 to 3.

1. **Do:** `cd contracts/business-wallet && cargo test`. **See:** 28 tests pass, including a stolen admin key failing to pay itself.
2. **Do:** `pnpm install && pnpm db:start && createdb fr33world_test && pnpm --filter @fr33world/api economy:week`. **See:** a simulated week, ending in `No USDC created: it all adds up.`
3. **Do:** read a live wallet from the chain:
   `curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"sunnys-grocery.fr33world.testnet","method_name":"summary","args_base64":"e30="}}'`
   **See:** a result whose bytes decode to Sunny's balance, limits and suppliers. Or open [the account on NearBlocks](https://testnet.nearblocks.io/address/sunnys-grocery.fr33world.testnet).
4. **Do (needs testnet keys in `.env`):** `pnpm --filter @fr33world/chain smoke:near`. **See:** a sale, a supplier payment and a delivery paid on the real chain, then each attack refused with its reason. Ends in `All good.`
5. **Do (needs testnet keys in `.env`):** `pnpm --filter @fr33world/api economy:live`. **See:** one player's whole story through the real API routes and the real chain: wallet linked, a Hot Meal bought with USDC, Sunny's reordering and paying its supplier, the delivery paid to the player, USDC sent on, with a NearBlocks link for each payment. Only Privy is stood in for, by a local key signing the same hash. Ends in `All good.`

## Honest limits

- This public copy leaves out the character animation files, whose licence doesn't allow sharing them on their own. Steps 1 to 4 don't need them. To play with animations, use the hosted game.
- It runs on NEAR Testnet with `usdc.fakes.testnet`, a community test token from the public faucet, not Circle's USDC. Test USDC has no value. Mainnet needs everything in [docs/mainnet-checklist.md](docs/mainnet-checklist.md).
- The chain can't see a delivery happen: the game server reports it. That's why limits live in the contract: a compromised server can only do what those allow.
- Contracts are unaudited. Player-owned businesses are designed for but not built.

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

## Car certificates on Solana (Devnet)

`pnpm --filter @fr33world/chain spike` mints a car to a test wallet, checks the game's freeze and transfer rights, and retries everything to prove it's idempotent. Results and how to run it against a local validator are in [docs/devnet-spike.md](docs/devnet-spike.md).

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
