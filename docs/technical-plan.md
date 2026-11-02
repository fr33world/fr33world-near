# fr33world — Technical Plan v2

**Status:** The owner's answers of 2026-10-28 are applied. We're waiting on the items in §14 before the prototype starts.
**Supersedes:** the parts of [m0-technical-review.md](m0-technical-review.md) listed in §1. The rest of that review still stands.
**Decisions:** [decision-log.md](decision-log.md)

> This project is a new game. It is separate from the earlier Lagos-based FreeWorld (`Works/Fullstack/FreeWorld`). None of that project's map, currency or design assumptions apply. We only reuse its free assets, with their licenses carried over.

---

## 1. What changed

| Topic                   | v1 review said                  | Owner decision (2026-10-28)                                                                                   | Plan v2                                                                                             |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| City                    | Generic city, about 2×2 km      | **Heavily inspired by Los Angeles**                                                                           | An original LA-inspired city of about 3×3 km (§2)                                                   |
| Time of day             | Fixed time, baked lighting      | **Server time and day/night, like GTA/OneState**                                                              | A server-authoritative clock with dynamic sun, sky and night lighting (§4)                          |
| Engine                  | Babylon.js after a bake-off     | **Three.js preferred**                                                                                        | Three.js, with no bake-off (§5)                                                                     |
| Scale                   | Tens to low hundreds of players | **500 players per server, low latency**                                                                       | 500 is the design target, proven with a 500-bot load test (§6)                                      |
| Art                     | Open (who builds it?)           | **Claude produces it** with free downloads plus your earlier assets. **Realistic textures, not mediocre.**    | A procedural city with photoscanned CC0 materials, curated free models and reused assets (§3, §12)  |
| Chain                   | Open                            | **Devnet now, easy switch to Mainnet**                                                                        | Cluster set by config, with a Mainnet go-live checklist (§8)                                        |
| Vehicle trading         | Non-transferable until reviewed | **Players trade cars with each other, priced however they like, with a web2-simple UX**                       | An in-game marketplace that settles in `$`. The game moves the on-chain asset for the players. (§8) |
| Economy                 | Ledger                          | **Designed against cheating from day one**                                                                    | A closed-loop ledger with invariants, caps and anomaly detection (§7)                               |
| Weapons                 | Open                            | **Desert-Eagle-style pistol and AK-style rifle**                                                              | Server-validated hitscan with lag compensation (§9)                                                 |
| Age                     | Open                            | **18+ only. Under-18s can't enter the app.**                                                                  | An age gate before any gameplay (§10)                                                               |
| Faction pay and joining | Open                            | **Salary every 10 min online (later 30). Application, training and interview, then the boss accepts. Ranks.** | A recruitment pipeline, rank permissions and salary accrual (§11)                                   |

**Unchanged from v1:**

- Owner-simulated, server-validated movement
- Binary WebSockets with area-of-interest updates (§6 tunes them)
- Rapier physics
- The reordered first-time flow
- Privy authentication and guests
- Deliver-first vehicle minting
- LiveKit proximity voice
- The milestone order

---

## 2. The city: original, LA-inspired

**Rules:**

- It's an original city that evokes LA. It's **not** a recreation and not GTA's Los Santos.
- No real trademarks: no "HOLLYWOOD" sign text, studio names, real brands or real shop names.
- It needs its own name. Working-name suggestions are in §14.

**Planning size:** about **3 × 3 km** of playable area. That's bigger than v1 because LA reads as freeways, long boulevards and sprawl. Low-density areas (grid residential, industrial) are generated procedurally, so they're cheap per km². The hand-crafted effort goes into the dense core and the landmarks. The size will be confirmed by a full-city greybox drive-through.

| Area (working names)   | LA inspiration             | Look                                                                                       | Gameplay anchors                                                        |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Downtown               | DTLA                       | Glass towers, a skyline, a grid, an Art-Deco city hall                                     | Police HQ, the main dealership, the taxi rank, the spawn/tutorial plaza |
| The Boulevard          | Hollywood / Sunset         | Neon signs, clubs, theaters, palm medians                                                  | Nightlife social hub, courier stops                                     |
| The Hills and the sign | Hollywood Hills / Griffith | Winding roads, mansions, a big hillside sign with **original text**, a hilltop observatory | Viewpoints, scenic driving, luxury homes                                |
| Palm Heights           | Beverly Hills              | Wide palm-lined avenues, upscale shops                                                     | Luxury car showroom                                                     |
| Beach City and Pier    | Santa Monica / Venice      | Pier with a Ferris wheel, boardwalk, sand, lifeguard towers                                | Social hub and a meeting spot                                           |
| South Grid             | South LA                   | Low-rise houses, corner stores, alleys                                                     | Gang turf, courier stops                                                |
| Concrete river         | LA River                   | A concrete flood channel with bridges                                                      | An iconic landmark and driving set-piece                                |
| Port and industrial    | San Pedro / Vernon         | Containers, cranes, warehouses                                                             | Courier depot, ore buyer                                                |
| Foothill quarry        | San Gabriel foothills      | A dusty quarry and machinery                                                               | Mining                                                                  |
| Medical campus         | Cedars-style               | A distinctive hospital                                                                     | Medical faction, respawn                                                |
| Freeway loop           | The 10/110/101             | Elevated freeways and a **four-level stack interchange**                                   | Fast travel by car, a skyline landmark                                  |

**How I'll build it (art production):**

1. **Greybox the whole 3×3 km map first:** road network, terrain heightmap, block footprints. Then drive it and time the routes.
2. **A procedural road generator** that builds lanes, markings, sidewalks, curbs, intersections, freeway ramps and the stack interchange from a spline graph.
3. **A procedural building generator per architectural style:** glass towers, Art-Deco, stucco houses, warehouses, and so on. Facades use photoscanned CC0 materials and **interior-mapped windows**, a shader that fakes rooms behind the glass. It's the biggest cheap realism win for cities. Every building gets seeded variation so nothing repeats visibly.
4. **Hand-made landmarks** in Blender, scripted: the sign, the observatory, the pier and Ferris wheel, city hall, the stack interchange.
5. **Set dressing:** instanced palms, street furniture, signage, decals for cracks, oil stains and road wear, and vegetation scattered by rules.

---

## 3. "Realistic, not mediocre": what that means in a browser

**An honest bar:** a high-end browser game that looks like a premium mobile open-world game, not GTA V. Realism comes from materials, lighting and composition more than polygon count.

| Technique                                                     | Low tier                 | Medium tier         | High tier (desktop, recent iPhone)                 |
| ------------------------------------------------------------- | ------------------------ | ------------------- | -------------------------------------------------- |
| Photoscanned PBR materials (CC0), KTX2-compressed             | ✓ (smaller mips)         | ✓                   | ✓                                                  |
| Physically based sky, atmospheric haze (the LA "golden haze") | ✓                        | ✓                   | ✓                                                  |
| HDR image-based lighting blended by time of day               | ✓                        | ✓                   | ✓                                                  |
| Baked ambient occlusion (doesn't depend on time of day)       | ✓                        | ✓                   | ✓                                                  |
| Dynamic sun shadows (cascaded, near the player)               | Characters and cars only | ✓ 1–2 cascades      | ✓ 3 cascades                                       |
| Interior-mapped windows, lit windows at night                 | ✓                        | ✓                   | ✓                                                  |
| Decals (road wear, grime)                                     | Fewer                    | ✓                   | ✓                                                  |
| Screen-space AO, subtle bloom, AgX tone mapping, SMAA         | Tone mapping only        | Tone mapping + SMAA | All                                                |
| Reflections (car paint, wet streets later)                    | Environment map          | Environment map     | Environment map + screen-space reflections (later) |

**Limits worth knowing:**

- **Characters and cars** are where "free" hurts most. Free realistic vehicles are rare, and characters come from Microsoft Rocketbox (MIT; replaced MakeHuman on 2026-10-29), which is realistic but dated in its clothes. The wardrobe is the main quality gap. It's recorded rather than hidden.
- **Art-direction gate:** the prototype ends with screenshots of one finished LA block at noon, golden hour and night. You approve the look before I scale it to the city.

---

## 4. Server time and day/night

- **The world server owns the clock.** It broadcasts `(gameEpoch, realEpoch, rate)` on connect and whenever the clock changes. Clients compute the time locally, with no per-tick traffic. The HUD shows the in-game time.
- **Default rate: 1 in-game day = 48 real minutes,** so 1 game minute is 2 real seconds, as in GTA Online. It's configurable.
- **Lighting:**
  - A sun/moon directional light follows the clock.
  - The sky shader and the HDR lighting blend between dawn, day, dusk and night presets.
  - At night: lit windows (randomized per building), emissive streetlights with fake light pools, headlights, and a few real point lights near the player.
  - Night must stay readable.
- **Performance:** the sun moves slowly, so the shadow map refreshes every few frames instead of every frame. Baked AO is time-independent, so it survives day/night.
- **Later:** weather (rain, wet streets), driven by the same server clock.

---

## 5. Engine: Three.js

**Yes, Three.js is a good choice.** It also matches your previous project, so its asset pipeline and character work carry over. Two clarifications:

1. **The rendering engine doesn't affect network latency.** Latency comes from the distance to the server, the tick rate and the netcode (§6). Three.js versus Babylon only changes frame rate and how much engine we build ourselves.
2. **What Three.js gives us:**
   - A lean core and the largest ecosystem: `three-mesh-bvh` for fast raycasts, `postprocessing`, KTX2/meshopt loaders, and a WebGPU renderer for later.
   - Full control over the frame loop and memory, which matters on mobile.
   - The cost is that we assemble more ourselves: LOD/streaming, character LOD and the HUD bridge. That's fine, because we'd customize those anyway.

**Setup:**

- Vanilla Three.js with WebGLRenderer as the baseline. WebGPURenderer later, behind a quality flag.
- React only for menus and the HUD, via a throttled store.
- Rapier physics on both client and server.

---

## 6. 500 players per server with low latency

**What makes it low latency:**

| Factor               | Plan                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distance to server   | Host the world server in the region nearest most players. **You still need to tell me where the players are** (§14). Physics sets the floor at roughly 1 ms of round trip per 100 km of fiber. |
| Local responsiveness | Your own character and car are simulated on your device, so input feels instant at any ping.                                                                                                   |
| Tick rate            | 30 Hz snapshots for players within about 60 m (combat range). 15 Hz mid-range, 5 Hz far. Only players in your area of interest are sent.                                                       |
| Combat fairness      | Lag-compensated server hit checks (§9)                                                                                                                                                         |
| Transport            | Binary WebSocket with small quantized packets and no JSON on the hot path                                                                                                                      |

**Server capacity for 500:**

- **Input:** 500 players × 20 Hz movement updates = 10k small messages per second. That's fine for one Node process if the hot loop uses typed arrays, a spatial hash and no per-message allocation.
- **Output:** the real cost. The worst case is everyone crowded into one spot, which means 500² visibility pairs. To handle it:
  - Cap each player's area of interest at the nearest **64 players** at full rate.
  - Send further players at a low rate or only as positions.
  - Encode each snapshot once per grid cell and fan it out.
- **Bandwidth:** about 10–25 KB/s down per player. A typical server egress is about 5–12 MB/s at 500 players.
- **WebSocket library: needs your call.**
  - `ws` (what you used before) is simple and pure JS.
  - `uWebSockets.js` uses several times less CPU and memory per connection, which matters at 500. It's a native addon installed from GitHub.
  - **My suggestion:** put the transport behind an interface, **load test both with 500 bots in the prototype**, and pick by the measured numbers.
- If one process can't hold 500 at target tick times, move the area-of-interest encoding into worker threads. A different language for the server is the last resort.

**The client side of 500 players is the real bottleneck.** A phone can't draw 100+ full-detail animated humans.

- Character LOD: full detail for the nearest **24**.
- Simplified mesh and animation for up to 80.
- Baked-animation impostors beyond that.
- Name tags culled by distance.

---

## 7. Economy designed against cheating from day one

**Goal:** nobody can create money, duplicate money or items, or own "a billion" except through the designed rules. And if something slips through, we detect it within minutes and can reverse it cleanly.

1. **Closed-loop money.**
   - `$` is created only by **faucets** the server defines: job payouts, faction salaries, the starter grant, tutorial rewards.
   - It's destroyed only by **sinks**: dealership, fuel, repairs, hospital, fines, trade fees, ammo, licenses.
   - Each faucet has a config rate and **per-character hourly and daily caps**.
2. **A double-entry, append-only ledger** in PostgreSQL. Amounts are `BIGINT` cents, never floats. Every movement is a transaction with balanced entries and a **unique idempotency key**.
3. **Balances can't go negative.** A DB `CHECK` enforces it. Writes take row locks, or use `SERIALIZABLE` where needed, so concurrent double-spends fail.
4. **No client-supplied money amounts are trusted.** The server computes every reward. The only player-entered amounts are marketplace prices and player-to-player payments, and both are bounded, rate-limited and logged.
5. **Continuous invariant check:** the sum of balances must equal faucets issued minus sinks burned, checked every minute. A mismatch triggers an alert and pauses economy writes.
6. **Anomaly detection:**
   - Earnings velocity above cap or above the 99.9th percentile triggers a flag.
   - A balance above a threshold goes to a review queue.
   - Trade patterns that look like laundering get flagged, for example many cheap sales to one account.
7. **Anti-dupe:**
   - One active world session per character.
   - Items and vehicles have unique IDs and move through ledger-style transfers. Nothing is copied.
8. **Admin hygiene:** there is no "set balance". Corrections are compensating ledger entries with a reason, and every admin action goes to the audit log.
9. **Tests:** replay, concurrent double-spend, negative and overflow amounts, idempotency, faucet caps. A headless economy simulator tunes faucets and sinks before launch.

_Your earlier project has a tested double-entry ledger with these invariants (`packages/ledger`). I'd like to port it rather than rewrite it; see §14._

---

## 8. On-chain vehicles and player-to-player trading (web2 UX)

**What's on-chain:** only each individual car, as a Metaplex Core asset that acts as its "ownership certificate". The `$` currency, levels, jobs and everything else stay off-chain.

**Devnet now, Mainnet by configuration:**

- The cluster is selected by `SOLANA_CLUSTER=devnet|mainnet-beta`. A per-cluster config holds the RPC URL, collection address and a reference to the authority key.
- **Mainnet is blocked by a flag and a checklist:**
  - Security review.
  - The authority key in a managed secret store.
  - A funded fee payer, about 0.003 SOL per car.
  - Monitoring.
- Devnet certificates don't carry over to Mainnet. At switch-over, a batch job re-mints certificates for existing cars on Mainnet.

**Trading, the way players see it.** There are no wallets, signatures, "NFTs" or gas.

1. **List:** in the Garage, tap your car, then "Sell", set a price in `$`, and confirm. The car appears in the in-game **Autos marketplace**. You can also hand it over directly to a nearby player through a trade window that both of you confirm.
2. **Buy:**
   - The buyer taps "Buy" and the `$` moves through the ledger in one atomic transaction. The seller gets paid minus a small fee (a money sink).
   - The car moves to the buyer's garage **immediately**.
   - A small "Ownership registered ✓" badge appears once the on-chain transfer confirms.
   - A "View certificate" link sits under an advanced section for the curious.

**Under the hood:**

- Cars are minted with **permanent freeze and transfer delegates held by the game**, so the server can move a certificate between players' embedded wallets after the `$` settlement without asking anyone to sign.
- If the delegates don't combine as expected, the fallback is a single atomic transaction that thaws, transfers and re-freezes. The prototype's Devnet spike will confirm which works.
- On-chain transfers run in a background queue with idempotent retries, just like minting. Assets stay frozen against outside transfers, so **the on-chain owner can only change through the game**, and the game database and the chain can't drift apart.
- **Selling for SOL on outside marketplaces stays off.** That keeps the economy closed (no cash-out, less incentive to bot). It can be enabled later by thawing assets, as a separate decision.

**Anti-abuse rules for car trades** (all configurable):

- Minimum level to trade.
- A price floor of 30% of the dealership price, so cars can't be used to pass money cheaply.
- A resale cooldown of 24 hours.
- A trade fee of 5%, which is a money sink.
- Guests can't trade.
- Every trade is logged and checked by the anomaly rules in §7.

---

## 9. Weapons and combat

**Weapons:**

- A **".50 Heavy Pistol"**, styled after a Desert Eagle.
- An **"Assault Rifle"**, AK-style.
- Real trademarked names and logos are not used in-game. GTA does the same. The models are generic and unbranded.

**How players get weapons** (proposed):

| Who        | How                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Police     | Issued from the station armory when going on duty, returned when going off duty                                        |
| Civilians  | A gun store (original name) sells the pistol from level 5 with a firearms license bought in-game. No rifle.            |
| Gangs      | A black-market dealer sells the pistol and the rifle (rifle from a set gang rank) at a higher price, no license needed |
| Ammunition | Sold in stores and acts as a money sink                                                                                |

**Rules:**

- **Safe zones:** the spawn plaza, hospital, police HQ and dealership. Weapons are disabled there.
- Weapons are holstered by default.
- Kill logs and rule reporting (random killing, vehicle ramming) go to moderators.

**Hit validation (server-authoritative, low latency):**

1. The client fires, shows muzzle flash and hit feedback immediately, and sends `shot{weapon, origin, dir, clientTime, seq}`.
2. The server checks that the weapon is owned and equipped, ammo is available, the fire rate is legal, the origin is near the player's validated position, and the player is outside safe zones.
3. **Lag compensation:** the server keeps about 1 s of position history per player. It rewinds targets to what the shooter saw (now − half RTT − interpolation delay, capped at about 200 ms) and raycasts against capsule hitboxes (head, torso, limbs) and the static world.
4. The damage table is applied. The authoritative result is broadcast and the hit shows on everyone's screen.

**Health:**

- When HP reaches 0 the player is **downed**, with a bleed-out timer.
- A medic can revive them, or they can respawn at the hospital for a fee.
- This feeds the Medical faction.

**Mobile aiming:** an aim button with light aim-assist (target snap within a small cone), because touch aiming is hard. Desktop uses mouse aim.

**Animation:**

- Mixamo pistol and rifle locomotion packs, plus shoot, reload and hit-reaction clips. These need your Adobe login; the list is in §12.
- Upper-body aiming is layered over lower-body locomotion with masked animation blending.

---

## 10. 18+ only

- Right after login and before anything else, players enter their **date of birth**. Under 18 means no entry: a polite block screen, and the account and device are flagged so a different date can't simply be re-entered.
- The ToS states 18+, and acceptance records the version and timestamp. Voice is therefore 18+ by construction.
- **Note:** self-declared date of birth is the common baseline. Some jurisdictions (for example the UK, Australia and some US states) can require stronger age assurance for user-to-user voice and chat. Get legal advice before a public launch.

---

## 11. Factions: recruitment, ranks and salary

**Recruitment pipeline:** Applied → Training → Interview → Accepted, or Rejected at any stage. Each step is server-validated.

| Step                     | Police                                                                                                         | Medical                                                                | Gang                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Apply                    | An in-game application form (via the phone or tablet app), with short answers and availability                 | Same                                                                   | A gang member with recruit permission invites the player, who then applies |
| Training (server-graded) | Academy: a rules quiz, a driving course (checkpoint time trial) and a shooting range score                     | A first-aid quiz, an ambulance driving course and a treatment minigame | Initiation tasks set by the gang, for example a contraband run             |
| Interview                | In person at police HQ with a member who has interview permission. The outcome is recorded in the faction app. | Same, at the hospital                                                  | With a gang officer at the hideout                                         |
| Accept                   | The boss, or a rank with accept permission                                                                     | Same                                                                   | Same                                                                       |

**Ranks and permissions:**

- **Police:** Cadet → Officer → Sergeant → Lieutenant → Captain → Chief.
- **Medical:** Trainee → EMT → Paramedic → Doctor → Chief of Medicine.
- **Gang:** Associate → Member → Enforcer → Lieutenant → Boss.
- Each rank carries a permission set: interview, accept, promote, fire, armory, dispatch, and so on.
- Leaders can promote players up to one rank below their own. Every action is audit-logged.
- The **first boss of each faction is appointed by an admin**, which needs a small admin tool.
- Gangs: I propose **two starting gangs** with their own boss, colors and turf, extensible later.

**Salary:**

- Paid **for every 10 minutes of active on-duty time**. The interval is a config value and becomes 30 minutes later.
- "Active" means online, on duty, and with input or interaction in the last 5 minutes. AFK time doesn't count.
- Time accumulates across reconnects. Each completed interval pays the rank's salary through the ledger with key `salary:{character}:{intervalNo}`, so it can't be paid twice.
- Salary is a faucet with a daily cap like the others (§7).

---

## 12. Assets: reuse, download, model

**Reused from your earlier project** (licenses carried with them):

| Asset                                                                                                | Source                          | License                                                             |
| ---------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| 28 animation clips: locomotion, idle, dances and emotes, punch and knock-out, sit, talk, wave, phone | Mixamo, downloaded by you       | Mixamo terms: use embedded in games; raw files aren't redistributed |
| Male and female characters with LOD1 and LOD2: 32 faces with their hair, 26 outfits (recolourable)   | Microsoft Rocketbox             | MIT                                                                 |
| Photoscanned PBR textures (concrete, asphalt, tiles, wood, plaster…)                                 | ambientCG                       | CC0                                                                 |
| Furniture                                                                                            | Kenney / Quaternius / self-made | CC0                                                                 |
| Asset registry, budget checks and Blender scripts (`packages/assets-tools`)                          | Your code                       | Yours                                                               |

**What I'll download myself (no account needed):**

- **Poly Haven:** HDRI skies, photoscanned materials, models such as trees and props. CC0.
- **ambientCG:** more materials (stucco, glass, asphalt variants, sand). CC0.
- **Kenney and Quaternius:** only for filler, because they're stylized.
- Each download gets a license snapshot and a registry entry.

**What you'll need to download** (these need your login; I'll give exact links when we reach them):

- **Mixamo (Adobe):**
  - Pistol Handgun Locomotion Pack
  - Rifle 8-Way Locomotion Pack
  - Clips: shooting, reloading, hit reactions, death/downed, entering and exiting a car, driving, CPR/kneeling, police-style poses
- **Sketchfab** (free account): candidate CC0 or CC-BY unbranded cars and weapons. I'll shortlist specific models and check each license before you download.

**What I'll model** (scripted Blender or procedural): roads, buildings, landmarks, street furniture, signage, and any vehicles or weapons where free models don't meet the bar.

---

## 13. Revised prototype scope: "Horizon Block" v2

**Purpose:** retire the big risks with numbers and get your sign-off on the look, before building the whole city.

1. **One finished LA block, about 500 × 500 m:** a downtown edge, a palm boulevard and a stretch of elevated freeway, built through the real pipeline. It uses procedural buildings with interior-mapped windows, CC0 photoscanned materials, palms, decals, the far-skyline proxy, and day/night on a server clock. **Ends at the art-direction gate:** screenshots at noon, golden hour and night for your approval.
2. **A reused character:** a MakeHuman body plus Mixamo clips, with a Rapier character controller and a third-person camera.
3. **One drivable car** with Rapier's raycast vehicle. The server grants the seat, and the controls switch when you get in or out.
4. **Controls:** a mobile joystick, look area and action buttons, plus a driving layout. Desktop uses WASD and pointer-lock mouse.
5. **Netcode at scale:**
   - The world server uses the area-of-interest tiers from §6, movement validation and corrections.
   - **500 headless bots**, comparing `ws` and `uWebSockets.js`.
   - A network conditioner (150 ms RTT, jitter, 2% loss).
6. **Crowd rendering:** 100 remote players near the camera on your iPhone and Android, testing the character LOD tiers.
7. **Combat slice:** the pistol only. Lag-compensated hitscan against moving bots, downed state.
8. **Measurement:** an in-game performance overlay, plus an automated route that logs fps (p50/p5), draw calls, memory, load times, bytes per second, and server tick time.
9. **Side spikes:**
   - LiveKit proximity voice on iPhone, Android and the Mac.
   - Privy login, guest accounts and the age gate.
   - A Devnet Core mint plus **a game-mediated transfer of a frozen asset**.

**Proposed exit targets** (confirmed after the first measurements):

| Metric                          | Target                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------- |
| Android and iPhone, Medium tier | ≥ 30 fps p50 and ≥ 24 fps p5 over 10 minutes, with no tab reload in 20 minutes   |
| Mac, High tier                  | ≥ 60 fps                                                                         |
| Server with 500 bots            | 30/15/5 Hz tiers with a tick under 15 ms on the target VM size                   |
| Network per client              | ≤ 25 KB/s down in a 64-player crowd                                              |
| Combat                          | Hits register correctly at 150 ms RTT. No hit through walls. Fire rate enforced. |
| Look                            | You approve the art-direction screenshots                                        |

**Out of scope for the prototype:** menus, character creation UI, jobs, factions, the economy UI, and the full city.

---

## 14. Needs your answer before the prototype starts

1. **Where are most players?** This decides the server region, and therefore the actual latency.
2. **WebSocket library:** benchmark `ws` against `uWebSockets.js` and choose by the numbers. Is that OK?
3. **Port your old ledger and binary protocol code** (`packages/ledger`, `packages/protocol`) into this project, adapted, instead of rewriting them?
4. **Car trades:** settle in in-game `$` inside the game, with SOL sales on outside marketplaces kept off for now. Agree?
5. **City name:** your own choice, or one of these working names: _San Solano_, _Los Altos Bay_, _Vista Del Mar_.
6. **Go-ahead** for the "Horizon Block" v2 prototype in §13.
