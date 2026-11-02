# fr33world — M0 Technical Review

**Status:** Partly superseded by [technical-plan.md](technical-plan.md) (v2, owner answers of 2026-10-28). The superseded parts are the engine (now Three.js), time of day (now server clock and day/night), map (now LA-inspired, about 3×3 km), scale (now 500 players), vehicle transferability (now in-game trading), and the remarks about the earlier Lagos project, which is a separate game.
**Date:** 2026-10-28
**Reviews:** [prd.md](../prd.md) (revised draft for technical review)
**Companion docs:** [decision-log.md](decision-log.md), [track.md](../track.md)

---

## 0. Summary

**Repository state.** The repository contains only `prd.md`. There is no code, no assets, no git history, and no existing architecture to preserve. Everything below is greenfield.

**Verdict.** A browser-based, PWA-installable, OneState-style multiplayer roleplay city is feasible. **GTA-level fidelity is not**, and the PRD should say so explicitly. The project succeeds if four constraints are accepted up front:

1. **Visual target:** clean "stylized-realistic" art built for mobile budgets, with baked lighting and a fixed time of day for the MVP. Not photorealism and not a dynamic day/night cycle.
2. **World size:** a planning envelope of about 2 km × 2 km of playable space with a dense downtown core and a non-playable backdrop beyond it. This is big enough to drive, work, and explore, and small enough to build and stream.
3. **Netcode:** each client simulates its own character and vehicle, and the server validates what it sends. Every consequential state change is server-authoritative (money, jobs, seats, ownership, interactions). Full server-side physics with client prediction for vehicles costs too much for the MVP and doesn't feel better on mobile networks.
4. **Population:** one world process per server with interest management. Capacity is set by measurement, probably tens to low hundreds of players, with a defined behavior when the server is full.

**The biggest risk is content production, not the engine.** A coherent full city with roads, terrain, buildings, vegetation, landmarks, characters, and vehicles is mostly an art and level-design pipeline problem. The PRD has no art resourcing plan. That's the first thing that will slip.

**The most important PRD issues** (details in §3):

- **Vehicles are a cash-out path.** Vehicles bought with grindable in-game `$` and freely tradable on-chain let players convert play into SOL. That contradicts §14 ("no cash-out in MVP") and invites bot farming.
- **The launch chain is undefined.** Acceptance criteria 17–19 require on-chain ownership at release, but Devnet minting is P1 and Mainnet is gated. Nothing says what chain the vehicles live on at launch.
- **Guest accounts are not "stable".** Privy guests are device-local, expire after 30 days unless upgraded, and can't be merged into an existing account.
- **The first-time flow has ordering bugs:**
  - Player data is "synced" before login.
  - The main menu shows a character the player hasn't created yet.
  - Notification permission is requested before the game has shown any value. On iPhone that request is impossible outside an installed PWA.
- **Dependencies are out of order.** The taxi job (M3) and the tutorial's vehicle step (M2) both depend on vehicles (M4).
- **Factions have nothing to act on.** The Medical faction needs injured players, and Police and Gangs need incidents. The PRD defines no health, damage, incident, or combat model.

**Recommended stack** (pending prototype results):

| Layer          | Choice                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Client         | React + TypeScript for menus and HUD. Babylon.js for rendering, with a WebGL2 baseline and WebGPU opt-in later.                              |
| Physics        | Rapier, the same WASM build on client and server                                                                                             |
| Game server    | Node.js + TypeScript. A custom world server over binary WebSockets with a spatial-grid AOI. An HTTP API (Fastify) for accounts and commerce. |
| Data           | PostgreSQL with a double-entry ledger. No Redis until a second process needs it.                                                             |
| Voice          | LiveKit SFU with subscriptions driven by the game server                                                                                     |
| Auth / wallets | Privy (email, Google, Discord, X, guest). Embedded Solana wallets.                                                                           |
| Chain          | Metaplex Core, Devnet first. The game server is mint authority and fee payer, so players never sign to buy a car.                            |
| Assets         | Blender → glTF → gltf-transform (meshopt + KTX2 + LOD) → tiled manifest on a CDN                                                             |

**What I need approved before major implementation** is listed in §17. Many items need a product owner's answer, not an engineering one: target region and devices, art resourcing, transferability of vehicles, combat scope, and the age policy.

---

## 1. Repository inspection

| Item                     | Finding                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Files                    | `prd.md` only                                                                                                  |
| Framework / dependencies | None                                                                                                           |
| Version control          | Not a git repository. Run `git init` before any code lands.                                                    |
| Assets                   | None. No characters, vehicles, environment, audio, screenshots, or logo.                                       |
| Prior work               | The PRD says "do not revert to a Lagos-based map", which implies an earlier direction. None of it exists here. |

**Consequence:** the loading-screen carousel (§4 Step 3) and login background (Step 5) need gameplay screenshots that can't exist until the game does. Plan approved concept renders as placeholders and replace them after the art pass.

---

## 2. Product direction, restated

fr33world is a single-city, single-server, persistent multiplayer roleplay game in the browser. Players create a character, learn the city through a tutorial, and earn `$` and XP through three hands-on jobs (mining, courier, taxi). They buy and drive cars, socialize by proximity text and voice, and later join Police, Medical, or Gang factions. Solana is invisible plumbing for vehicle ownership only. The game must feel like a mobile game, not a dApp.

**Possible misunderstandings to confirm:**

- **"No districts" (§3.2).** I read this as no gameplay or server partitions. The city still needs visually distinct neighborhoods (downtown, residential, industrial, coast, quarry), because players navigate by them. I'm assuming that's intended.
- **"Realistic game visuals" (§3.1).** I read this as grounded and believable, as opposed to cartoon or neon. It can't mean console realism on a mid-range phone in a browser.
- **"Mid-range mobile" is undefined.** The right device tier depends on the target market (§3, C15). The prior Lagos direction suggests West Africa may be a target. That would change device budgets, download budgets, and server region significantly.

---

## 3. Contradictions and gaps in the PRD

| #   | Where           | Issue                                                                                                                                                                                                                                                                                                                                                                                    | Recommendation                                                                                                                                                                                                                                                              |
| --- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | §4 Step 3       | The loading screen before login lists "Synchronizing player data" and "Preparing multiplayer connection". Neither can happen before authentication.                                                                                                                                                                                                                                      | **Two loading phases.** The boot load covers the UI, menu scene, audio, and login backdrop. The world-entry load, after PLAY, covers city tiles, character assets, the realtime connection, and player state. Both use the same cinematic component.                        |
| C2  | §4 Step 7 → 8   | The main menu shows "the player's character prominently", but new players create their character only after pressing PLAY.                                                                                                                                                                                                                                                               | After server selection, send players with no character on Horizon **straight to character creation**. Returning players land on the menu with their character.                                                                                                              |
| C3  | §4 Step 2       | Requesting notification permission second, before any value is shown. (1) On iOS, web push permission can only be requested from a PWA that has been added to the Home Screen, so it's impossible in a Safari tab. (2) Chrome demotes sites with low acceptance to a "quiet" prompt. (3) §4 also says to implement only categories the game supports, and P0 has none that justify push. | Move the soft prompt to **after the tutorial or the first time a real event exists**, such as faction dispatch (P1). Keep an in-game notification inbox in P0. Add an iOS "Add to Home Screen" guide, which is also what gives iPhone players a full-screen landscape view. |
| C4  | §4 Step 1       | Orientation. Last confirmed, iPhone Safari didn't support `screen.orientation.lock()` or element fullscreen. A landscape Safari tab also loses screen space to browser UI. Android Chrome supports both in fullscreen.                                                                                                                                                                   | Use a rotate prompt on mobile portrait. Request fullscreen and an orientation lock on TAP TO PLAY where supported (Android). Push PWA install on iOS. **Verify on iOS 26 devices in the prototype.**                                                                        |
| C5  | §21             | Taxi is in M3 but vehicles are in M4. The tutorial vehicle step is in M2.                                                                                                                                                                                                                                                                                                                | Move the driving foundation earlier, since the feasibility prototype already includes a drivable car. Taxi comes after the vehicle system.                                                                                                                                  |
| C6  | §8              | Medical needs injured players, and Police and Gangs need incidents and interactions. **The PRD defines no health, damage, incident, or combat model.**                                                                                                                                                                                                                                   | Define a minimal health/downed state and an incident system before factions (§10). Decide explicitly whether weapons and combat exist (D-11). This affects age rating, moderation, and payment-provider policies.                                                           |
| C7  | §11.2 vs §14    | Vehicles are bought with earned `$` and are freely tradable on-chain, so grinding converts into SOL. That's a de facto cash-out the PRD forbids. It rewards bots and farming and may raise regulatory questions.                                                                                                                                                                         | Mint vehicles as **non-transferable for the MVP** (Metaplex Core Permanent Freeze Delegate held by the game). Enable trading only after the economy, marketplace, and legal review. See §12.                                                                                |
| C8  | §11.2, §20, §22 | Acceptance criteria 17–19 require verified on-chain ownership at release. Devnet minting is P1 and Mainnet is gated behind review. Devnet assets mean nothing as ownership at a public launch.                                                                                                                                                                                           | **Decide (D-09):** either (a) launch with off-chain vehicles and mint certificates later, or (b) launch on Mainnet once the review passes. I recommend (a) unless on-chain ownership is a launch marketing requirement.                                                     |
| C9  | §4 Step 5       | "Stable guest identity … persist progress" doesn't hold. Privy guest sessions are stored on the device, expire after 30 days unless upgraded, and can't be merged into an existing account. Safari may also evict script-writable storage for sites that aren't installed and aren't used for 7 days (verify).                                                                           | Guests can play fully. Show upgrade prompts at meaningful moments (after character creation, before the first purchase). **Warn guests that logging into an existing account discards guest progress.** Guests don't receive on-chain assets.                               |
| C10 | §4 Step 6       | Selecting a server "connects the player to the game environment" before the menu. Holding realtime slots for players idling in menus wastes capacity.                                                                                                                                                                                                                                    | Get server status over HTTP. Open the realtime connection on PLAY.                                                                                                                                                                                                          |
| C11 | §13 vs §11.1    | "Clients should send inputs" suggests input-based server simulation. For vehicles on mobile networks at 80–250 ms RTT, that needs rollback-capable vehicle physics on the server.                                                                                                                                                                                                        | Use owner-simulated, server-validated movement (§7).                                                                                                                                                                                                                        |
| C12 | §3.1            | "Realistic", a "complete city", "mid-range mobile", a day/night cycle, and directional shadows pull against each other. Baked lighting, which is the cheap way to look good, conflicts with day/night.                                                                                                                                                                                   | Fixed time of day for the MVP, with baked lighting and AO plus one near-range shadow cascade. Day/night moves to Later.                                                                                                                                                     |
| C13 | §8 vs §22       | Factions are called "initial", but they're P1 and absent from the acceptance criteria.                                                                                                                                                                                                                                                                                                   | Clarify whether release 1 includes factions.                                                                                                                                                                                                                                |
| C14 | §4 Step 7       | The Store button implies purchases. Real-money purchases need a payment provider, refunds, and tax, and none of that is specified. Events has no defined content.                                                                                                                                                                                                                        | Hide Store and Events in P0, per the PRD's own "only show buttons with a destination" rule.                                                                                                                                                                                 |
| C15 | Whole PRD       | No target region or audience.                                                                                                                                                                                                                                                                                                                                                            | Needed for server region, latency, device tier, and download budget (D-12).                                                                                                                                                                                                 |
| C16 | §4, §10.5       | No minimum account age policy. In-game age isn't legal age, but proximity voice with strangers raises child-safety and regulatory obligations.                                                                                                                                                                                                                                           | Define a minimum age and an age gate (D-13). Voice is off by default until the player opts in.                                                                                                                                                                              |
| C17 | §3.2, §4 Step 6 | One server with no capacity number and no behavior when full.                                                                                                                                                                                                                                                                                                                            | Measure capacity in the prototype. Add a "Full" server status and a simple queue or retry.                                                                                                                                                                                  |
| C18 | §10.4           | Hugeicons has a free set and a paid Pro set.                                                                                                                                                                                                                                                                                                                                             | Confirm which license is in use.                                                                                                                                                                                                                                            |
| C19 | §16             | Push notifications and the in-game notification inbox are conflated. Push needs a service worker, VAPID keys, and a sender service.                                                                                                                                                                                                                                                      | Treat them separately. The inbox is P0 and push is P1.                                                                                                                                                                                                                      |
| C20 | §23             | Asset licensing is mentioned but not the web-specific problem. GLBs and textures in a browser game can be downloaded by anyone. Some marketplace licenses forbid distributing raw, extractable files.                                                                                                                                                                                    | Check every purchased asset's license specifically for web delivery.                                                                                                                                                                                                        |

---

## 4. Feasibility: a OneState/GTA-style city in a browser PWA

**What works in our favor**

- WebGL2 is universal on target devices. WebGPU now ships in Chrome (desktop and Android) and Safari 26, so it's available as an opt-in high tier.
- OneState itself is a modest-fidelity mobile game. Its look is reachable with disciplined budgets.
- Mature glTF tooling exists: meshopt compression, KTX2/Basis textures, and LOD generation.

**What constrains us**

| Constraint                                                              | Practical budget for the mid tier (validate in the prototype)                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Memory: mobile Safari and Chrome kill or reload tabs under pressure     | About 400–500 MB total, including GPU textures. Lower for the low tier.                                        |
| Draw calls                                                              | About 300–500 per frame on mobile                                                                              |
| Visible triangles                                                       | About 0.5–1M on mobile                                                                                         |
| Thermal throttling                                                      | Plan for **sustained 30 fps** on mobile, not 60                                                                |
| Main thread: rendering, physics, networking, and React share one thread | Keep React out of the frame loop. Consider moving physics or networking to a worker if profiling shows a need. |
| Download                                                                | Cold first-time world entry has to be tens of MB, not hundreds. Data cost matters more in some markets (C15).  |
| Transport                                                               | WebSockets everywhere. WebTransport isn't reliably available on iOS, so keep the transport abstracted.         |

**Assessment:** feasible at a "clean stylized-realistic, mobile-first" quality bar with quality tiers (Low/Medium/High chosen automatically, user-overridable). The prototype's job is to put numbers on cost per tile and cost per player, so the full city can be budgeted rather than guessed.

---

## 5. Rendering engine recommendation

**Recommendation: Babylon.js + Rapier**, confirmed by a short bake-off.

|           | Babylon.js                                                                                                                                              | Three.js                                                                                           | PlayCanvas (not in PRD, worth naming)                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Nature    | Full engine                                                                                                                                             | Rendering library                                                                                  | Full engine with a hosted editor                                        |
| Built in  | LOD, thin instances, octrees, occlusion queries, glTF + KTX2 + meshopt, an inspector, a spatial audio engine, baked vertex animation for crowds, WebGPU | Renderer, glTF, KTX2. The rest comes from the ecosystem (R3F, drei, three-mesh-bvh).               | Strong mobile-web track record, an asset pipeline, and an editor        |
| Trade-off | Larger bundle. Fewer community examples than Three.                                                                                                     | Maximum flexibility and the largest ecosystem, but we would assemble more of the engine ourselves. | The editor is a hosted SaaS, and the code-first workflow is less common |
| Fit here  | Best "batteries included" fit for a small team building a full game                                                                                     | Good if the team already has deep Three.js/R3F experience                                          | A viable alternative if the team wants an editor-first workflow         |

**Physics: Rapier, not Havok.** Rapier runs as the same WASM build in the browser and in Node. It has a kinematic character controller and a raycast vehicle controller, plus a cross-platform deterministic build if we ever need it. Sharing physics code and collision data between client and server is the important property, and it's independent of the renderer choice.

**Bake-off (part of the prototype, short and time-boxed):** load the same exported city tile, instanced vegetation, 30 skinned characters, one shadow cascade, and the same camera path in Babylon.js and Three.js. Compare frame time (p50 and p95), draw calls, memory, bundle size, and developer effort on the mid-tier Android device. **Decision rule:** choose Babylon unless Three is clearly faster on mobile (more than about 15% frame time) or the team strongly prefers it.

**React boundary:** React renders menus, the HUD, and overlays only. The game loop owns the canvas. The HUD reads from a small store updated at a throttled rate (about 10 Hz for slow values). Touch joysticks use raw pointer events, not React state.

---

## 6. World: size, layout, streaming, collision, pipeline

### 6.1 Planning envelope (for approval, adjustable after the prototype)

- **Playable area:** about 2 km × 2 km (about 4 km²). At city driving speed, crossing it takes 1–2 minutes. That's long enough for taxi and courier routes to matter, and small enough to fill with credible content.
- **Natural boundaries:** coastline on one or two sides, hills and the quarry on another, and a highway or river edge. Players reach an edge because of geography, not invisible walls.
- **Backdrop:** low-poly terrain, sea, and distant hills outside the playable area. Always loaded and very cheap. It makes the city feel embedded in a landscape.

### 6.2 Proposed layout (neighborhoods, not gameplay districts)

| Area                                         | Character                                      | Gameplay anchors                                                |
| -------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| Downtown core (about 600 m square)           | Towers and skyline, grid streets, plazas       | Dealership, Police HQ, main spawn and tutorial plaza, taxi rank |
| Commercial strip                             | Shops and mid-rise buildings along an arterial | Courier drop-offs, meeting spots                                |
| Residential (two styles: dense and suburban) | Houses, apartments, vegetation                 | Courier drop-offs, garages                                      |
| Hillside                                     | Upscale homes, elevation, viewpoints           | Landmark viewpoint, a scenic driving road                       |
| Industrial / port                            | Warehouses, cranes, containers                 | Courier depot, ore buyer                                        |
| Quarry (edge of map)                         | Terrain cut, machinery                         | Mining sites                                                    |
| Hospital campus                              | Distinct landmark building                     | Medical faction (P1)                                            |
| Coastal road / beach                         | Palms, promenade                               | Social space, scenic driving                                    |

**Roads:** a ring road, 3–4 arterials, a downtown grid, and winding hill roads. **Landmarks:** a hill sign or tower, a bridge, a stadium or arena silhouette, and a lighthouse. Each should be visible from far away for navigation.

**Step one is a greybox of the whole map.** Before any final art, block out the entire 2×2 km city in simple shapes. Then drive it and walk it, time the routes, and only then commit art. This is the cheapest guard against both "a single street" and "a big empty map".

### 6.3 Streaming and rendering strategy

- **Tiles:** a 250 m grid, about 64 tiles. Each tile ships:
  - LOD0, full detail, within about 250 m.
  - LOD1, merged and simplified, out to about 600 m.
  - A collision mesh.
  - Instance buffers for vegetation and props.
  - Gameplay markers.
- **Far city proxy:** the whole skyline as one merged low-poly mesh, always resident. The city reads as one place from anywhere, with no loading screens between areas.
- **Draw-call control:** per-tile static merging by material, texture atlases or array textures, and thin instances for trees, lamps, and props. Distance-cull small props aggressively.
- **Lighting:** baked lightmaps or vertex AO for static geometry, one directional light, and a single short-range shadow cascade (characters and vehicles only on the Low tier). Fixed time of day.
- **Occlusion:** rely on tile visibility and street-level layout. GPU occlusion queries are expensive on mobile. Precomputed visibility per tile is a later optimization if needed.
- **Prefetching:** stream tiles in the direction of travel. Vehicle speed sets the prefetch radius.

### 6.4 Collision and navigation

- Separate low-poly authored collision: boxes for buildings, a heightfield or trimesh for terrain, and road surfaces. Never collide against render meshes.
- **The server loads the entire collision set.** It's small and needed for movement validation. Clients load collision for nearby tiles only.
- A **road graph** exported from the map drives GPS routing, waypoints that follow roads (not through buildings), taxi fares, courier distances, and later NPC traffic.
- A pedestrian navmesh (Recast) comes later, for on-foot waypoints and NPCs.

### 6.5 Asset pipeline

```
Blender (source of truth, custom properties for gameplay markers)
  → glTF export per tile / per asset
  → tools/asset-pipeline (gltf-transform):
       dedupe · weld · meshopt compression · KTX2 (UASTC normals / ETC1S color)
       · LOD generation · static merge · budget validation (fails the build if over)
  → content-hashed files + manifest.json (sizes for real loading progress)
  → CDN
Gameplay data (spawns, job nodes, interaction zones, road graph)
  → map-data.json shared by client AND server (single source of truth)
```

**Characters:** one shared skeleton for male and female bases so animations are shared. Clothing and hair are modular. Skin tone is a material parameter, and faces are presets. Merge the parts into one skinned mesh per character at load time to save draw calls. Character LOD: full detail within about 30 m, reduced to about 80 m, and baked-animation or hidden beyond. Far characters update their animation at a lower rate.

**Art resourcing (open question):** the PRD needs an owner for environment art, characters, and vehicles. Options are in-house artists, contractors, or licensed kits. Purchased kits must be checked for web distribution (C20) and for visual coherence, because mixed packs are exactly the "disconnected asset packs" look §3.1 warns against.

---

## 7. Movement, vehicles, and multiplayer synchronization

### 7.1 Authority model

| Category                                               | Authority                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Own character and vehicle motion                       | **The owning client simulates it** (Rapier, fixed 60 Hz step). **The server validates it.** |
| Vehicle seats (enter, exit, driver)                    | Server. The client requests and the server grants.                                          |
| Interactions (pickups, deliveries, mining, dealership) | Server, which checks distance from its own validated position                               |
| Money, XP, inventory, jobs, factions, ownership        | Server only (ledger and state machines)                                                     |
| Remote entities on each client                         | Interpolated from server snapshots                                                          |

**Why not full server simulation with client prediction?** Vehicle physics would need deterministic re-simulation and rollback on the server and on every client. That's high server CPU per player and a long tail of mispredictions, and it looks bad at mobile RTTs. FiveM-style RP servers use owner simulation with validation for the same reason. The exploit surface left open is "move within legal limits", which is harmless because rewards depend on server state machines, not raw positions.

### 7.2 Server validation

Each movement update carries a sequence number, position, rotation, velocity, mode (foot or vehicle, plus which model), and animation flags. The server checks:

- Maximum speed and acceleration per mode and vehicle model, with a tolerance window.
- Vertical sanity (no flying; grounded when on foot).
- A swept raycast from the previous to the new position against static collision (no walking through walls).
- Map bounds.
- Seat consistency (vehicle motion only comes from the seated driver).

If a check fails, the server sends a correction and the client snaps back. Repeated failures raise flags, then kicks, and are logged.

### 7.3 Replication

- **Transport:** binary WebSocket messages with quantized fields. Positions are tile-relative 16/24-bit and yaw is 16-bit, so each entity update is about 20 bytes.
- **Interest management:** a spatial hash grid with 64 m cells. The AOI radius is about 150 m on foot and about 250 m in vehicles. Update rate falls with distance: 20 Hz near, 10 Hz mid, about 4 Hz far.
- **Estimated bandwidth:** 40 visible entities × 20 B × about 12 Hz average ≈ 10 KB/s down per client. The prototype will measure the real figure.
- **Remote rendering:** about 100 ms interpolation buffer. Vehicles use capped dead reckoning.
- **Vehicle-vs-vehicle contact:** on your client, remote vehicles are kinematic. Your car bumps into them but doesn't push them. This is normal for RP servers and acceptable for the MVP.

### 7.4 Session lifecycle

- The realtime connection authenticates with the Privy access token, which the server verifies on connect.
- On disconnect, the character stays in the world as a ghost for about 60 s. Reconnecting within that window resumes seamlessly. Job state lives on the server, so jobs survive reconnects.
- Position and state persist every 30 s and on disconnect.

---

## 8. Backend architecture and hosting

**A modular monolith in one monorepo** (pnpm workspaces):

```
apps/client          React shell + Babylon game runtime (PWA)
apps/api             Fastify HTTP: auth, accounts, policy acceptance, characters,
                     garage, dealership, purchases, reports
apps/world           Realtime world server: sessions, AOI, movement validation,
                     interactions, jobs runtime, chat, voice-subscription driver
apps/chain-worker    (P1) mint queue + ownership reconciliation
packages/shared      protocol, constants, map-data types, game rules
packages/db          schema + migrations (PostgreSQL)
tools/asset-pipeline gltf-transform scripts, budget checks
```

- **PostgreSQL** holds accounts, characters, `policy_acceptances` (version and timestamp), `ledger_entries` (double-entry, idempotency keys), cached balances, `job_runs`, vehicles, purchases, `chain_mints`, reports, and blocks.
- **Ledger:** every money movement is a ledger transaction with a unique idempotency key, such as `jobRun:{id}:payout`. Balances are derived or cached and can always be rebuilt from the ledger.
- **Hosting:**
  - The world server needs a long-lived, stateful VM or container with low latency to players. Serverless won't work.
  - Assets go on a CDN with immutable, content-hashed URLs.
  - **The region depends on D-12.** A server in Europe adds roughly 100–150 ms for West African players. A closer region or edge option should be evaluated if that's the market.
- **Scaling path:** one world process per server. Add Redis or pub/sub only when a second process exists, such as a second server or a split chat service.

---

## 9. First-time user experience: revised flow

The PRD's cinematic flow stays. The order changes to fix C1–C4, C9, and C10.

| #   | Step                                                      | Notes                                                                                                                                                                                                             |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Boot shell** (small)                                    | Registers the service worker and detects the device and quality tier                                                                                                                                              |
| 2   | **Orientation gate**                                      | Mobile portrait only. Never blocks desktop or devices that can't rotate. Uses an aspect-ratio and orientation media query, not user-agent sniffing.                                                               |
| 3   | **Boot loading screen** (cinematic carousel and tips)     | Loads the UI, fonts, menu scene, audio, and login backdrop. Real progress comes from manifest byte sizes and streamed fetch counts, with an indeterminate indicator otherwise. Includes an error and retry state. |
| 4   | **TAP TO PLAY**                                           | Resumes the AudioContext and starts music if preferences allow. On Android, requests fullscreen and a landscape lock.                                                                                             |
| 5   | **Login** (Privy) and **Terms/Privacy acceptance**        | The acceptance version and timestamp are recorded server-side. Guest entry is clearly labeled ("Progress saved on this device for 30 days. Link an account to keep it.").                                         |
| 6   | **Server select: Horizon**                                | Shows status over HTTP: online, full, or offline, with retry                                                                                                                                                      |
| 7a  | New player → **character creation**                       | Server-side name validation and uniqueness, then a confirmation step                                                                                                                                              |
| 7b  | Returning player → **main menu**                          | Shows their character. World tiles start prefetching in the background.                                                                                                                                           |
| 8   | **PLAY → world-entry loading** (same cinematic component) | Loads spawn tiles and character assets, opens the realtime connection, and syncs state                                                                                                                            |
| 9   | **Tutorial**                                              | Skippable and resumable, with progress stored server-side                                                                                                                                                         |
| 10  | **Notification soft-prompt**                              | After the tutorial, and only once a supported push category exists (P1). On iOS, only inside an installed PWA. Never re-prompt after a decline.                                                                   |
| —   | **"Install the app" guide**                               | Android: the native install prompt. iOS: an illustrated Add to Home Screen sheet. This is the only route to full-screen landscape and push on iPhone.                                                             |

**Platform checks for the prototype:**

- Privy OAuth (Google, Discord, X) inside an **installed** iOS and Android PWA, where standalone mode can break redirects.
- Audio unlock and the iOS silent switch.
- Microphone permission inside the standalone PWA.

---

## 10. Job framework and faction architecture

### 10.1 Shared server framework

```
JobDefinition   { id, eligibility(char), createRun(), logic: JobLogic }
JobRun          { id, characterId, jobType, state, objectives[], data, startedAt, version }
JobLogic        per-job module: generates objectives, validates events, computes reward
Validators      reached(point, radius) · interacted(target) · carrying(item)
                · occupying(vehicle, seat) · stoppedNear(point, maxSpeed) · elapsed(min)
Rewards         ledger write with idempotency key jobRun:{id}:{step}
Guards          per-job cooldowns, daily diminishing returns, rate limits, anomaly flags
Lifecycle       cancel · fail · timeout · resume-after-reconnect (state is server-side)
Analytics       run started/completed/failed, duration, payout, distance
```

The framework handles bookkeeping. **Each job owns its own gameplay.**

| Job         | Distinct loop                                                                                                                                                                                                                                                                                                                              | Server validation                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mining**  | 1. Travel to the quarry and pick a resource node (depletes and respawns on the server). 2. Do a hold-and-timing mining interaction with an animation; quality affects yield. 3. Ore goes into a weight-limited inventory and the player walks slower while carrying it. 4. Haul it to the buyer, on foot or by vehicle later.              | Distance to the node, minimum elapsed time, node stock, carry capacity, sale at a valid buyer                                                                                   |
| **Courier** | 1. Pick up a route of 3–5 packages at the depot. 2. Packages become tracked inventory items. 3. Navigate the road graph to each door marker and deliver by interacting. 4. Pay = base + road distance (computed by the server) + time bonus. No menu between stops.                                                                        | The package was really picked up. Delivery is at the correct marker. Distance comes from the server's road graph. Timing is plausible.                                          |
| **Taxi**    | _(Needs the vehicle system.)_ 1. Register at the taxi rank and get a company taxi, so no ownership is needed. 2. An NPC fare spawns at a roadside node. 3. Drive there, stop, and the passenger boards. 4. Drive to the destination, then stop within a radius at low speed to complete the trip. 5. Damage and abandonment fail the fare. | The driver occupied the taxi throughout. Sampled path length is at least about 0.8 × road distance. Speed limits were respected. Completion means stopped near the destination. |

### 10.2 Factions: what to build in P0 so P1 doesn't need a redesign

- **Data:**
  - `factions`
  - `faction_ranks`, each with a capability set such as `police.dispatch.receive` or `medical.revive`
  - `faction_memberships`
- **Checks:** every privileged action checks capabilities on the server. The client only displays them.
- **On duty:** an on/off-duty state controls uniform swaps and dispatch eligibility.
- **Health and downed state (new):**
  - HP with real damage sources: falls, vehicle impacts, and combat if approved (D-11).
  - At 0 HP the player is **downed**.
  - A medic can stabilize them; otherwise they respawn at the hospital after a timer, for a fee.
  - This gives Medical a real loop.
- **Incidents (new):**
  - Created by players ("call emergency services") or by the system (crashes, downed players).
  - Dispatched to on-duty members of the relevant faction, with location and status.
  - Police and Medical respond to incidents.
- **Police:** respond, run ID checks, and issue fines (a ledger transfer). Escort and detain come later.
- **Gangs:** membership, colors, a hideout, and gang jobs (for example, a contraband courier variant with risk).
- **Open question:** gang-vs-police interaction without any combat or pursuit mechanics is thin. That's decision D-11.

---

## 11. Proximity voice chat

### 11.1 Options

| Option                                                   | Verdict                                                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Peer-to-peer WebRTC mesh                                 | Rejected. Upload cost grows with each nearby player, it needs TURN anyway, and it can't be controlled by the server.                      |
| **SFU: LiveKit** (self-hosted or Cloud)                  | **Recommended.** It's open source, has a mature browser SDK, includes TURN, and supports server-controlled subscriptions and permissions. |
| mediasoup (custom SFU)                                   | More control, much more work                                                                                                              |
| Hosted proximity-voice SDKs (for example, 4Players ODIN) | Worth a cost comparison if self-hosting is undesirable                                                                                    |

### 11.2 Design

- One LiveKit room per server. **The world server decides who hears whom:**
  - Every 250–500 ms, it computes each listener's audible set: speakers within about 30 m, at most the 8 nearest, with hysteresis.
  - It pushes those subscription permissions through the LiveKit server API.
  - Clients can't subscribe to anyone the world server hasn't allowed, which prevents eavesdropping.
- Clients apply distance attenuation and panning locally.
- **Muting unpublishes or stops the mic track.** It doesn't just set gain to 0. This satisfies "stop transmitting immediately".
- **Block** removes both directions from subscriptions. **Report** captures who, when, where, and which speakers were nearby. No audio recording in the MVP (a privacy and legal decision).
- If microphone permission is denied, gameplay is unaffected and the mic button shows the state.

### 11.3 Known browser risks (the voice spike must test these)

1. **Chromium echo cancellation** doesn't cancel audio played through the Web Audio API. Spatialized voice through Web Audio therefore echoes for speaker users on Chrome. The known workaround, used by Mozilla Hubs, routes the output through a loopback `RTCPeerConnection` into an `<audio>` element.
2. **iOS** ignores `HTMLMediaElement.volume`, so attenuation must go through Web Audio. Opening the mic changes the iOS audio session and can duck or reroute game audio.
3. Microphone behavior inside an **installed** iOS PWA, and when the app is backgrounded.

### 11.4 Rough cost model

- Opus voice runs at about 24–32 kbps per stream, and silence suppression helps a lot.
- **Example:** 200 concurrent players, with about 2 speakers active per listener on average, gives 200 × 64 kbps ≈ 12.8 Mbps SFU egress. That's about 5.8 GB per hour, or about 4 TB per month at a constant 24/7 load.
- Self-hosted on a VPS with included bandwidth, that's cheap. On LiveKit Cloud it's billed by usage, so check current pricing.
- Voice is not a cost blocker at this scale.

---

## 12. Privy and Metaplex Core

### 12.1 Authentication

- The Privy React SDK runs on the client. **The server verifies Privy access tokens** on every HTTP request and on realtime connect, and maps the Privy user ID to an `accounts` row. The server never trusts a wallet address sent by the client; it reads linked wallets from Privy.
- **Login methods:** email, Google, Discord, X, and guest. All are Privy-supported, but each must be tested inside an installed PWA.
- **Guests:**
  - Device-local, 30-day expiry unless upgraded, can't be merged (C9).
  - Upgrading with `login()` keeps the same user ID, so characters carry over.
  - Logging into an existing account discards guest progress. Warn the player.
- **Cost:** Privy's official pricing page lists a free tier of up to 1,000 MAUs. Guests likely count as MAUs. Model the cost per MAU before launch.

### 12.2 Vehicle assets: recommended design

- **Standard:** Metaplex Core. One collection, "fr33world Vehicles", with the model ID in the Attributes plugin. The metadata URI points to our metadata API for display data. Mutable gameplay state stays off-chain.
- **Cost:** about 0.003 SOL per asset (rent plus fee), **paid by the game treasury**. Players never need SOL.
- **No player signature to buy.** The price is in-game `$` (off-chain), so the server is mint authority and fee payer and mints directly to the player's embedded wallet. This is what keeps Web3 invisible.
- **Delivery comes before minting.** The purchase debits `$` through the ledger and creates the off-chain vehicle immediately, so the player drives away. A background worker then mints the on-chain asset as an ownership certificate, which satisfies §11.3: nobody is charged for an undelivered car.
- **Idempotent minting:**
  1. Generate the asset keypair server-side and **persist it before submitting**.
  2. If a transaction expires, check whether an account exists at the asset address.
  3. If none exists, resubmit with a fresh blockhash using the same keypair.
  4. A duplicate mint is impossible because the address is fixed.
  5. Mint states: `queued → submitted → confirmed → verified`, plus `failed_retrying`, which alerts.
- **Transferability (D-08):** create assets with a **Permanent Freeze Delegate** held by the game (it can only be added at creation). They stay non-transferable until trading is approved, then the game thaws them. This closes the C7 cash-out path while keeping the option open. The cost is one thaw transaction per asset later.
- **Guests:** they get off-chain vehicles only. The mint is queued when they upgrade to a full account.
- **Ownership verification** (needed once transfers are possible): the reconciliation worker watches asset ownership through a DAS-capable RPC or webhooks.
  - The on-chain owner maps to a game account through Privy-linked wallets.
  - If the owner's wallet isn't linked to any account, the vehicle becomes unclaimed in-game.
  - If the vehicle is transferred while someone is driving it, it despawns and returns to its garage.
- **No custom Solana program.** Core plugins cover the MVP. A marketplace (Later) can use a Transfer Delegate with server co-signed settlement.
- **Keys:** keep the mint/update authority and fee payer in a KMS or secrets manager, separate from each other. Never put them in plain environment variables in production. Stay on Devnet until a security review passes (§15.3).

---

## 13. Revised priorities

**P0: core playable foundation.** The PRD's P0, with these changes:

- **Add:**
  - Two-phase loading
  - New players go to character creation before the menu
  - An install-to-home-screen guide
  - An in-game notification inbox
  - Server capacity limits and a "Full" state
  - An age gate (D-13)
- **Move to P1:**
  - The push-notification permission prompt and push delivery (no supported category exists in P0)
- **Hide:**
  - Store and Events menu buttons
- **Keep in P0 but sequence later:**
  - Proximity voice ships in P0, but only after the movement netcode is proven, as the PRD itself states
- **Design in P0, build in P1:**
  - Faction capability model and the health/downed state, so P1 isn't a redesign

**P1: factions and ownership**

- Police, Medical, and Gang factions
- Incidents and dispatch
- Health and downed gameplay
- Push notifications (dispatch, invites)
- Devnet mint-on-purchase (non-transferable) and reconciliation
- Expanded customization

**Later**

- Vehicle trading and marketplace (after economy and legal review)
- Mainnet (unless D-09 says launch)
- Day/night cycle
- Interiors, NPC traffic and pedestrians
- Additional jobs and servers

---

## 14. Recommended development sequence

The PRD's milestones are reordered by actual dependencies. No calendar estimates until M0 closes, as the PRD requires.

| Milestone                             | Contents                                                                                                                                                             | Exit condition                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **M0a: Prototype and spikes**         | §16 prototype, engine bake-off, voice spike, Privy + Core spike                                                                                                      | Measured numbers on target devices                               |
| **M0b: Decision review**              | Approve §17 and finalize targets                                                                                                                                     | Decision log signed off                                          |
| **M1: World and movement foundation** | Asset pipeline. **Whole-city greybox.** Character + camera + collision. **Driving with one vehicle.** Accounts and the persistent character record.                  | Walk and drive the full greybox city with a persistent character |
| **M2: Multiplayer and onboarding**    | World server with AOI and validation. Full first-time flow. Character creation. Main menu. Text chat and interaction prompts. Tutorial (including the vehicle step). | New players onboard and meet others                              |
| **M3: Economy and first jobs**        | Ledger, XP and levels, the job framework, **courier and mining**. Dealership and garage (off-chain). Vehicle persistence.                                            | Real job loops pay validated rewards, and players can buy a car  |
| **M4: Taxi, voice, polish**           | Taxi job, proximity voice, report and block, reconnect hardening, vehicle control polish on mobile                                                                   | All P0 systems functional                                        |
| **M5: Factions and ownership**        | Health and incidents, the three factions, push notifications, Devnet minting and reconciliation                                                                      | P1 functional                                                    |
| **M6: Beta**                          | Device matrix, load tests, exploit tests, licensing audit, monitoring                                                                                                | Acceptance criteria met                                          |

**Art track (parallel, from M1):** greybox → blockout → final art, area by area, starting with downtown and the tutorial plaza. This determines the schedule more than engineering does.

---

## 15. Risks and testing

| Risk                                                        | Likelihood / impact | Mitigation and test                                                                                          |
| ----------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Art production can't fill a coherent 4 km² city             | High / High         | Greybox first. Per-tile budgets. A dedicated art owner. Kit-based modular buildings with variation.          |
| Mobile memory or thermal limits crash tabs                  | Medium / High       | Quality tiers, budget checks in CI, 20-minute soak tests on the low and mid tiers                            |
| iOS PWA quirks (orientation, fullscreen, OAuth, audio, mic) | High / Medium       | Real-device checklist in the prototype and on every release                                                  |
| Voice echo and iOS audio routing                            | Medium / Medium     | Voice spike on Chrome Android, Safari iOS, and desktop with speakers                                         |
| Economy exploits and botting                                | Medium / High       | Server state machines, idempotent ledger, diminishing returns, anomaly dashboards, non-transferable vehicles |
| Mint failures or desync                                     | Medium / Medium     | Deliver-first design, a persisted keypair, the reconciliation worker, and alerting                           |
| Unknown single-server capacity                              | Medium / Medium     | Bot load test in the prototype, a capacity cap, and a queue                                                  |
| Asset licensing (especially web extractability)             | Medium / High       | A license register in the repo, reviewed before each asset lands                                             |
| Child safety and voice moderation                           | Medium / High       | Age gate, voice opt-in, report and block, a moderation process before beta                                   |

**Test suites to stand up early:**

- Unit tests for ledger, job, and purchase state machines, including idempotency and replay.
- Headless bot clients for load and network chaos (latency, jitter, loss).
- An automated benchmark route that reports frame-time stats.
- A real-device matrix checklist.
- Devnet integration tests for mint, retry, and reconciliation.

---

## 16. First playable prototype: proposed scope ("Horizon Block")

**Purpose:** answer the feasibility questions with numbers. It's throwaway where convenient. It doesn't need final art and it's not the city.

### In scope

1. **World slice:** one representative area of about 400 × 400 m (downtown grid, one hill, a park with vegetation, one landmark, about 2 tiles' worth of density), built **through the real pipeline**. The far-city proxy is included so the skyline reads. Fixed sun, baked AO, one shadow cascade.
2. **Engine bake-off:** the same tile and benchmark route in Babylon.js and Three.js, time-boxed.
3. **Character:** one rigged character with idle, walk, run, and jump; a Rapier kinematic controller; a third-person camera with collision.
4. **Vehicle:** one car using Rapier's raycast vehicle, with enter and exit through a server-granted seat.
5. **Input:**
   - Mobile: left joystick, right-side look area, context buttons, and a driving layout.
   - Desktop: WASD, pointer-lock mouse, and driving keys.
   - The control layout switches when entering or leaving the car.
6. **Networking:**
   - Node world server with binary WebSockets, 20 Hz, a spatial-grid AOI, interpolation, and movement validation with corrections.
   - Headless bots simulating 50–100 players walking and driving.
   - A network conditioner (150 ms RTT, ±30 ms jitter, 2% loss).
7. **Measurement:** an in-app performance overlay and an automated benchmark route that logs:
   - fps p50/p5, frame time, draw calls, and triangles
   - JS heap and estimated GPU memory
   - cold and warm load times and bytes transferred
   - network bytes per second
   - server tick time
8. **Side spikes (in parallel, minimal UI):**
   - **Voice:** LiveKit with 10 clients and server-driven proximity subscriptions, tested on iOS Safari (tab and installed), Chrome Android, and desktop Chrome. Echo and mute behavior.
   - **Privy and Core:** login (email, Google, Discord, X, guest) in an installed PWA, embedded Solana wallet creation, guest upgrade, a server-side Devnet Core mint with a Permanent Freeze Delegate, forced-expiry retry, and ownership read-back.

### Out of scope

Final art, menus, character creation, jobs, economy, factions, chat, final UI styling, and PWA polish (beyond install testing).

### Proposed exit targets (to confirm after the first measurements; these are not launch commitments)

| Metric                              | Target                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Mid-tier Android, Medium quality    | ≥ 30 fps p50 and ≥ 24 fps p5 across a 10-minute session (thermal), with no tab reload in 20 minutes               |
| Recent iPhone, Medium quality       | Same as Android                                                                                                   |
| Integrated-GPU laptop, High quality | ≥ 60 fps p50                                                                                                      |
| Memory (mid tier)                   | JS heap < 300 MB and GPU textures < 200 MB                                                                        |
| Cold world entry (prototype slice)  | ≤ 20 s at 20 Mbps, then warm (cached) ≤ 8 s                                                                       |
| Network                             | ≤ 15 KB/s down per client with 50 players in AOI. Server tick ≤ 10 ms with 100 bots.                              |
| Feel                                | Smooth remote motion under the conditioner. Responsive local driving on touch. Validated subjectively on devices. |

**The prototype's output:** an extrapolation of cost per tile and per player to the full 2×2 km city, a confirmed engine choice, confirmed targets, and the go/no-go list for §17.

**Devices needed:** at least one mid-range Android (chosen to match the target market), one iPhone, and one integrated-GPU laptop. Please name the actual devices available.

---

## 17. Decisions needed before major implementation

Each item is tracked in [decision-log.md](decision-log.md).

| ID   | Decision                                 | Recommendation                                                                           |
| ---- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| D-01 | Visual target and lighting               | Stylized-realistic, baked lighting, fixed time of day, quality tiers                     |
| D-02 | Planning map size                        | About 2 × 2 km playable, greybox first, revisit after the prototype                      |
| D-03 | Rendering engine                         | Babylon.js, confirmed by bake-off                                                        |
| D-04 | Physics                                  | Rapier on client and server                                                              |
| D-05 | Movement authority                       | Owner-simulated, server-validated. Server-authoritative for all state.                   |
| D-06 | Network stack                            | Custom world server, binary WebSockets, spatial AOI                                      |
| D-07 | First-time flow changes                  | Two-phase loading, creation before menu, notifications after the tutorial, install guide |
| D-08 | Vehicle transferability                  | Non-transferable (Permanent Freeze Delegate) until economy and legal review              |
| D-09 | Chain at launch                          | Off-chain vehicles at launch with deliver-first minting later, or Mainnet at launch?     |
| D-10 | Voice infrastructure                     | LiveKit SFU with world-server-driven subscriptions                                       |
| D-11 | Combat and weapons scope                 | Product decision needed. It shapes factions, rating, and moderation.                     |
| D-12 | Target region, audience, and device tier | Product decision needed                                                                  |
| D-13 | Minimum age and voice policy             | Product decision needed. Voice opt-in recommended.                                       |
| D-14 | Guest model                              | 30-day device-local with clear upgrade prompts. No on-chain assets for guests.           |
| D-15 | Store and Events in P0                   | Hidden until defined                                                                     |
| D-16 | Art resourcing                           | Product decision needed: who builds the city, characters, and vehicles                   |
| D-17 | Prototype scope and exit targets         | As in §16                                                                                |

---

### Sources consulted for platform facts

- [Privy: guest accounts](https://docs.privy.io/recipes/react/guest-accounts), [Privy: guest login](https://docs.privy.io/authentication/user-authentication/login-methods/guest.md), [Privy: Solana embedded wallet creation](https://docs.privy.io/guide/react/wallets/embedded/solana/creation), [Privy pricing](https://www.privy.io/pricing)
- [Metaplex Core: create asset (costs)](https://www.metaplex.com/docs/smart-contracts/core/create-asset), [Core: transfer](https://www.metaplex.com/docs/smart-contracts/core/transfer), [Core: soulbound assets](https://developers.metaplex.com/core/guides/create-soulbound-nft-asset)
- [OneSignal: web push for iOS](https://documentation.onesignal.com/docs/web-push-for-ios), [Notificare: iOS web push and Add to Home Screen](https://notificare.com/blog/2024/09/16/web-push-in-ios-add-to-home-screen/)
- [WebKit bug 257695: ScreenOrientation lock](https://bugs.webkit.org/show_bug.cgi?id=257695), [AppleInsider: Safari in iOS 26 (WebGPU)](https://appleinsider.com/articles/25/06/18/how-safari-in-ios-26-macos-26-puts-content-first-with-liquid-glass-ui-changes)
- [LiveKit: spatial use cases](https://livekit.io/use-cases/metaverse), [PixelHub (Colyseus + LiveKit proximity voice)](https://github.com/mateuseap/pixelhub)
- [atmoky: Chromium echo cancellation and Web Audio](https://docs.atmoky.com/known-issues), [Babylon forum: echo cancellation workaround](https://forum.babylonjs.com/t/browser-audio-cancellation-doesnt-work-using-babylons-sound-component/16759)
