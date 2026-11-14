# Development notes

Running, deploying and testing the whole game. The project overview is in the [README](../README.md).

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

Secrets live in `.env` at the repo root (git-ignored); copy `.env.example` to start. Progress and the full roadmap are in [track.md](../track.md).

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

**World server (Render):** [render.yaml](../render.yaml) is a Render Blueprint for the free plan: the world server as a web service (WebSocket at `/ws` plus the HTTP API). In the Render dashboard: **New → Blueprint**, pick the repo, then enter `PRIVY_APP_ID` and `PRIVY_APP_SECRET` when asked.

Add the client's address to the Privy dashboard's allowed domains.

The free plan sleeps the world server after 15 minutes with nobody connected. The client wakes it (about a minute) and says so on the login screen. Its limits and what they mean for players are in [track.md](../track.md) under Hosting.

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

Results are in [docs/load-test-results.md](load-test-results.md).

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
