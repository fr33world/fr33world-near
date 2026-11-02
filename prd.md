# fr33world — Product Requirements Document (PRD)

**Product:** fr33world  
**Document type:** Product Requirements & Technical Direction  
**Status:** Revised draft for technical review  
**Platform:** Browser-based 3D multiplayer game, installable as a PWA  
**Target devices:** Mobile and desktop  
**Visual references:** OneState RP, GTA, and modern mobile open-world games  
**Blockchain:** Solana  
**Authentication and embedded wallets:** Privy

---

## 1. Product Vision

fr33world is a persistent, multiplayer, open-world roleplay game where players create a character, explore a realistic city, interact with other players, earn money through jobs, progress through levels, and choose their own role in the world.

The game should feel like a conventional 3D mobile game rather than a Web3 application. Blockchain functionality should remain largely invisible during ordinary gameplay.

The experience should take inspiration from the presentation, world design, character movement, driving, and roleplay systems found in games such as OneState RP and GTA, while developing its own identity, progression, economy, and gameplay systems.

**Product principle: Build a believable city, give players meaningful ways to live in it, and let their decisions define their experience.**

## 2. Core Product Goals

1. Build one complete, recognizable city map with defined topography, roads, buildings, landmarks, vegetation, and surrounding scenery.
2. Deliver a polished game-launch experience, from loading screen through character creation and entry into the world.
3. Support real-time multiplayer movement and interaction.
4. Provide third-person character controls optimized for landscape mobile gameplay, with a desktop control scheme.
5. Implement functional jobs rather than simple start-and-finish task buttons.
6. Establish three main roleplay factions: Police, Medical, and Gangs.
7. Implement levels, experience, money, missions, rewards, and progression.
8. Support vehicles, driving, dealerships, garages, and persistent vehicle ownership.
9. Include proximity voice chat so nearby players can communicate naturally.
10. Use Solana for selected ownership and trading features, not every in-game action.
11. Support mobile and desktop through a browser-based experience that can be installed as a PWA.
12. Build an architecture that can expand without requiring the entire game to be rewritten.

## 3. Product Scope and World Design

### 3.1 The city

fr33world must have a **full standalone city map**, not a tiny test environment, a single street presented as the whole game, or a Lagos-specific recreation.

The city should feel like a complete place with recognizable geography and a coherent layout. It should be bounded enough to develop, optimize, and operate realistically, but large enough for players to explore, drive, work, meet other players, and discover locations.

The city must have:

- A clearly defined overall map and navigable street network.
- Main roads, secondary roads, intersections, junctions, and road markings.
- Residential areas, commercial streets, taller buildings, and a recognizable skyline.
- Elevation changes and terrain that make the city feel geographically coherent.
- Blue skies, sunlight, directional shadows, and a consistent lighting model.
- Palm trees, flowers, grass, shrubs, and other vegetation distributed naturally.
- Sidewalks, street furniture, signs, barriers, and environmental details.
- Vehicle and pedestrian routes that make sense within the map.
- Recognizable landmarks that help players navigate.
- A day/night cycle if it can be delivered without compromising the MVP's performance.

The environment should not look like disconnected asset packs placed on a flat plane. Roads, terrain, buildings, lighting, vegetation, and landmarks must work together to create a believable city.

The art direction should prioritize realistic game visuals and readable environments. Avoid excessive glow, gradients, artificial-looking materials, and generic AI-generated visual styling.

### 3.2 Map size and boundaries

There are no separately defined districts in the initial release. All players use one connected city map and one initial game server.

Do not interpret the absence of districts as a requirement to make the world small. The goal is a complete city map with meaningful variety.

The exact playable area, road layout, landmarks, and terrain dimensions must be determined during the world-design and technical-prototype stages. They should be based on gameplay routes, player density, visibility, asset budgets, and device performance rather than an arbitrary map-size number.

### 3.3 Functional and decorative buildings

Not every building needs a working interior or interactive systems at launch.

**Interactive locations** are the places required for core gameplay, such as:

- Job locations and work equipment.
- A vehicle dealership.
- Garages and vehicle service areas.
- Police and medical facilities.
- Gang-related locations where required by the implemented faction systems.
- Character onboarding and tutorial destinations.
- Other locations directly required by an implemented mission.

**Decorative locations** establish the city around these points. They may have exterior detail, windows, doors, signs, and environmental storytelling without supporting entry or interaction.

Decorative buildings must still look credible and fit the map. Avoid making every building a flat placeholder or an identical repeated asset.

### 3.4 World streaming and performance

The city must be designed for browser delivery.

Use appropriate combinations of:

- Level of detail (LOD).
- Frustum and occlusion culling where supported.
- Instanced vegetation and repeated objects.
- Compressed textures and optimized 3D models.
- Progressive asset loading.
- Spatial partitioning and visibility management.
- Efficient collision geometry.
- Reuse of environment assets without making the city visibly repetitive.

Load the world in manageable sections when needed, but preserve the feeling of one connected city. The player should not experience unnecessary loading screens whenever they move between ordinary parts of the map.

Claude Code must evaluate whether the chosen rendering engine and asset strategy can deliver the intended city quality on both desktop and mid-range mobile devices.

## 4. First-Time User Experience

The first-time experience should follow the sequence below. It should feel like launching a normal mobile game, not opening a conventional website dashboard.

### Step 1: Landscape orientation

On mobile, detect whether the device is in landscape orientation.

If the user is in portrait mode, show a full-screen orientation prompt asking them to rotate their device before entering the game experience.

The prompt should use a clear visual illustration and concise text. It must not trap desktop users or devices that cannot rotate.

Landscape is the primary mobile gameplay orientation.

### Step 2: Notification permission

After the orientation step, introduce notifications at an appropriate point in the first-time experience.

Explain the value of notifications before requesting permission. The player should be able to enable notifications or skip and continue.

Do not repeatedly prompt users who decline.

Notifications may later cover relevant game events such as mission updates, faction invitations, or other supported account activity. Only implement notification categories that the game actually supports.

Browser and PWA notification permissions must be handled according to the platform's capabilities and restrictions.

### Step 3: Cinematic loading screen

Show a full-screen loading experience with gameplay imagery.

#### Background carousel

Use a series of high-quality gameplay screenshots or approved game renders.

The transition should work as follows:

1. One image is displayed at full opacity.
2. The next image fades in gradually while the current image fades out.
3. The transition continues smoothly through the image sequence.
4. Images should be composed to accommodate loading text and tips without hiding the important gameplay subject.

The result should feel cinematic and calm, not like a fast slideshow.

#### Loading status

At the bottom of the screen, show a loading indicator and a short status message that reflects actual loading progress.

Possible messages include:

- Preparing game environment...
- Loading city assets...
- Loading character assets...
- Preparing multiplayer connection...
- Synchronizing player data...
- Finalizing game session...

These are examples, not hardcoded stages that must always appear. Show messages that match the work actually taking place.

Where possible, report real progress. If exact progress is unavailable, use an honest indeterminate loading indicator rather than inventing a percentage.

#### Gameplay tips

Display short gameplay tips in a dedicated area on one side of the screen.

Examples:

- Explore the city to discover new opportunities.
- Complete jobs to earn money and gain experience.
- Stay close to other players to interact with them.
- Visit a garage to manage your vehicle.

Tips must correspond to existing or planned functionality and should not promise features that are not available.

#### Loading behavior

The loading experience must not simply be an animation covering a frozen application. The game should load essential assets, establish the necessary session, and handle errors and timeouts.

If loading fails, provide a useful error state with a retry option.

### Step 4: Tap to Play

When the required resources and session are ready, replace the loading status with a prominent **TAP TO PLAY** prompt.

The player's tap or click should activate the next stage of the experience.

This interaction can also start background music, subject to browser autoplay restrictions. Audio should not begin before an appropriate user gesture.

Persist audio preferences so that the game respects the player's mute and volume settings in future sessions.

### Step 5: Login and account entry

Show a login screen using one static, high-quality gameplay image as its background.

Keep the screen visually consistent with the game rather than making it resemble a generic SaaS authentication page.

Supported entry options:

- Continue with email.
- Continue with Google.
- Continue with Discord.
- Continue with X, subject to provider availability and integration feasibility.
- Play as guest.

Use Privy for supported authentication and embedded wallet creation.

The authentication interface must clearly communicate any account requirements and allow users to understand whether their progress will be saved.

#### Guest access

Guest play should provide the lowest-friction entry path where technically practical.

Guest accounts should use a stable guest identity and persist progress according to the supported account model. Provide a way to link or upgrade the guest account to a permanent login without losing the character or progress.

If a particular provider cannot be supported by the selected authentication configuration, Claude Code must document the limitation and propose the closest viable alternative instead of displaying a nonfunctional button.

#### Terms and policies

Before proceeding into the game, require acceptance of the Terms of Service and Privacy Policy.

Provide accessible links to both documents. Record the accepted policy version and timestamp.

Do not treat a link to the policies as a substitute for explicit acceptance.

### Step 6: Server selection

After authentication, show a server-selection screen.

For the initial release, there should be only one selectable server.

**Recommended initial server name: Horizon**

Display the server name, connection status, and availability. The server-selection architecture should support additional servers in the future, but do not build a complex server browser for the MVP.

Selecting Horizon should connect the player to the correct game environment and continue to the main menu.

If the server is unavailable, show its status and a retry option rather than silently sending the player elsewhere.

### Step 7: Main menu

Once the player is authenticated and connected to the server, show the main game menu.

The presentation should resemble the main menus of modern mobile open-world games, using OneState and GTA as references without copying their exact layouts or assets.

The main menu should feature:

- The player's character prominently in the center.
- A visually rich city or game environment behind the character.
- Player level and experience progress.
- Current in-game money, displayed using `$` as the initial currency symbol.
- Notification access.
- Settings.
- Logout.
- Large rectangular action buttons for important game activities.
- A prominent **PLAY** button to enter the world.

#### Main-menu action buttons

Recommended initial buttons:

| Button   | Purpose                                                             |
| -------- | ------------------------------------------------------------------- |
| Tasks    | View available tasks, active objectives, and progress               |
| Jobs     | Discover and access available jobs                                  |
| Factions | View Police, Medical, and Gang entry points, subject to eligibility |
| Events   | Display active game events when implemented                         |
| Store    | View supported in-game purchases and items                          |
| Garage   | View owned vehicles and available vehicle management options        |
| Settings | Configure audio, controls, graphics, and other preferences          |

Only show buttons that have a meaningful destination. Unimplemented features must not appear as functional menu options.

The menu should remain readable on different screen sizes. Use a consistent icon system based on Hugeicons for interface icons, with clear labels and touch-friendly controls.

Logout should be available from the settings or account menu and should require confirmation when there is a risk of interrupting an active session.

### Step 8: Character creation

If the player has no character on the selected server, pressing PLAY opens character creation before world entry.

Returning players with an existing character should bypass first-time character creation and proceed to the appropriate game-entry flow.

Character creation must support:

**Identity**

- First name.
- Last name.
- In-game age.
- Gender: male or female.

**Appearance**

- Skin tone.
- Face or facial preset.
- Hairstyle.
- Hair color.
- Clothing.
- Other practical appearance options supported by the available character assets.

The interface should display a live 3D character preview where feasible, allowing the player to see the effect of their selections.

Provide a clear confirmation step before creating the persistent character.

Names must follow server-side validation and uniqueness rules. Do not rely on client-side validation alone.

The initial version should prioritize a good selection of compatible presets over an overly complex character editor. Character appearance should persist across sessions.

The character's in-game age is a roleplay attribute, not the player's legal age or a substitute for account age requirements.

## 5. Tutorial and First Entry into the City

After a new character is created, the player enters the world at level 1 and begins a guided tutorial.

The tutorial should introduce movement, interaction, basic city navigation, and the first earning opportunity.

### 5.1 Assistant character

Introduce a female in-game assistant who guides the player through the tutorial.

She should appear in an appropriate context, such as greeting the player at a designated arrival point.

When the assistant speaks, display the explanation in a readable dialogue block. The player should not be forced to rely on audio to understand the instructions.

The assistant should be visually consistent with the game's character art and should feel like an in-world guide, not an unrelated chatbot.

### 5.2 Tutorial flow

The proposed sequence is:

1. **Welcome:** The assistant welcomes the player and explains that the city is open for exploration.
2. **Movement:** Teach the player how to move and control the camera.
3. **Navigation:** Introduce the map or navigation system and guide the player to a nearby destination.
4. **Interaction:** Teach the player how to interact with an NPC, location, or object.
5. **First task:** Introduce an initial job or practical activity.
6. **Rewards:** Explain money, experience, and levels.
7. **Vehicles:** Introduce vehicle interaction when the player reaches a suitable location and the vehicle system is ready.
8. **Social play:** Explain how to interact and communicate with nearby players.

Use a visible waypoint or directional indicator to guide the player to the current objective. The indicator should update as the player moves and should not point through inaccessible geometry.

The tutorial should teach through actual gameplay, not through a long sequence of text screens.

### 5.3 Skipping and resuming

The player must be able to skip the tutorial.

Skipping should not break the character, job, inventory, or progression state. The game should retain access to essential controls and basic help.

Where appropriate, tutorial progress should be saved so an interrupted session can resume without forcing the player to repeat completed steps.

After completion or skipping, the player is free to explore the city and choose their next activity.

## 6. Core Gameplay Loop

The central gameplay loop is:

1. Enter the city.
2. Explore and discover locations.
3. Meet and interact with other players.
4. Take jobs or participate in faction roleplay.
5. Earn money and experience.
6. Buy or manage items and vehicles.
7. Increase levels and unlock progression.
8. Develop a reputation and establish a role in the city.
9. Continue exploring, working, socializing, and participating in the evolving world.

Players should be able to choose different paths. A player should not be forced to join a faction to earn a reasonable living or participate in ordinary city life.

Progression should reward activity without making the game feel like a repetitive menu-driven grind.

## 7. Jobs and Employment

Jobs must be implemented as gameplay systems with their own mechanics, state, and progression.

**Do not implement jobs as a generic Start button followed by a Finish button that awards money.**

Each job should have a believable activity loop, meaningful player input, and server-validated rewards.

The first three casual jobs are:

1. Mining.
2. Delivery courier.
3. Taxi driver.

### 7.1 Mining

Mining should involve travelling to a designated mining location, interacting with mining equipment or a resource node, and performing a mining activity.

Potential mechanics include:

- Discovering and reaching mining sites.
- Starting and controlling an appropriate mining interaction.
- Animation and equipment use.
- Resource extraction with defined duration and outcomes.
- Tool durability or other limitations if justified.
- Carrying or transporting mined materials.
- Delivering materials to a supported buyer or collection point.
- Earning money and experience according to server-side rules.

Mining should have clear feedback and should not be a single interaction that instantly produces unlimited resources.

The initial version should use a small number of resource types and a manageable number of mining locations. More complex crafting and resource economies can come later.

### 7.2 Delivery courier

Delivery work should involve accepting or receiving a delivery, collecting the correct package, travelling to a destination, and delivering it.

Potential mechanics include:

- Job availability and acceptance.
- Package pickup and state tracking.
- Navigation to the correct destination.
- Carrying or transporting the package.
- Delivery confirmation through a valid interaction.
- Reward calculation based on defined factors such as distance, delivery completion, and time where appropriate.
- Cancellation, interruption, and recovery behavior.

The server must verify that the package was collected and delivered correctly before issuing a reward.

The job should support multiple deliveries and clear feedback without forcing the player to navigate repetitive menus after every action.

### 7.3 Taxi driver

Taxi work should involve picking up passengers and transporting them to destinations.

Potential mechanics include:

- Registering for taxi work.
- Access to an eligible vehicle.
- Receiving or accepting a passenger request.
- Travelling to the pickup point.
- Picking up the passenger through a valid interaction.
- Driving to the destination.
- Completing the trip and receiving a reward.
- Handling cancellation, vehicle damage, disconnection, or an interrupted trip.

NPC passengers may be used initially if the full player-to-player passenger system is not ready. If player passengers are introduced, the system must support consent, pickup confirmation, and safe trip-state management.

Taxi work must depend on actual driving and destination completion, not merely waiting for a timer.

### 7.4 Job architecture

All jobs should use a reusable server-side framework for:

- Eligibility.
- Job state and progression.
- Objective validation.
- Rewards and experience.
- Cancellation and failure.
- Reconnection and recovery.
- Anti-exploit checks.
- Analytics and balancing.

However, the reusable framework must not flatten every job into identical gameplay. Mining, courier work, and taxi driving require different interaction and activity systems.

Future jobs may be added after the initial three work reliably.

## 8. Main Roleplay Factions

The initial roleplay factions are:

1. Police.
2. Medical.
3. Gangs.

The PRD should refer to these as **factions**, not organizations.

Faction membership should be distinct from casual employment. Casual jobs provide earning opportunities; factions provide specialized roleplay, responsibilities, progression, and access to faction-specific gameplay.

### 8.1 Police

The police faction should support the foundations of lawful public-safety roleplay.

Potential mechanics include:

- Joining or applying to the faction according to server rules.
- Rank and experience progression.
- Uniforms and faction identity.
- Dispatch or incident notifications.
- Interaction with reported incidents.
- Player identification and lawful roleplay interactions.
- Appropriate vehicles and equipment when implemented.

Do not build an extensive criminal justice simulation before the underlying player interaction and incident systems work.

### 8.2 Medical

The medical faction should support medical-response roleplay.

Potential mechanics include:

- Joining or applying to the faction.
- Medical ranks and progression.
- Responding to eligible incidents.
- Reaching and interacting with an injured player.
- Basic treatment or stabilization.
- Transporting a patient where supported.
- Medical facilities and appropriate vehicles.

The initial medical system can use a simplified health and injury model. It should still produce meaningful gameplay rather than being a cosmetic job title.

### 8.3 Gangs

The gang faction should support criminal-roleplay identity and interactions within explicit server rules.

Potential mechanics include:

- Membership and rank.
- Gang identity, clothing, or other visual identifiers.
- Faction-related missions or activities.
- Reputation and progression.
- Defined interactions with other factions.

More complex systems such as territory wars, elaborate crime chains, large faction economies, and advanced police investigations should be deferred until the foundational systems are stable.

### 8.4 Faction rules

Faction membership, ranks, permissions, and rewards must be validated server-side.

The game should not give a player privileged faction capabilities merely because the client claims that they belong to a faction.

Factions should be designed so that they can expand over time without requiring a redesign of the character, job, or permissions systems.

## 9. Levels, Experience, and Progression

Every character begins at level 1.

Experience should be awarded for meaningful, validated activity, including completed jobs, tutorials, and supported roleplay objectives.

The progression system should include:

- Character level.
- Current experience.
- Experience required for the next level.
- Reward and progression history.
- Unlockable content where implemented.
- Optional level-related titles or visual indicators.

Avoid giving unlimited experience for repeated low-effort actions. Rewards must be validated by the server and designed to discourage farming and exploits.

Levels should indicate progress without making new players completely irrelevant to experienced players.

## 10. Gameplay HUD and Controls

The gameplay screen should follow the general layout and readability of modern third-person mobile open-world games, taking inspiration from OneState and GTA without copying their exact interface.

The HUD must prioritize the world itself. UI elements should remain legible while allowing the player to see the character, vehicles, nearby players, and environment.

### 10.1 Mobile on-foot controls

The default mobile layout should support:

- A virtual movement joystick on the left.
- A camera/look control area on the right.
- Context-sensitive interaction buttons.
- Jump or other essential movement actions where supported.
- A microphone button for proximity voice chat.
- Map or navigation access.
- Essential gameplay status and objective indicators.

Controls must use appropriately sized touch targets and avoid unnecessary screen clutter.

The camera must not fight the player's movement input. Sensitivity and control layout should be configurable where practical.

### 10.2 Desktop controls

Desktop users should have a keyboard-and-mouse control scheme appropriate for third-person movement and driving.

The controls should be documented in settings and should not require users to use mobile-style on-screen controls.

### 10.3 Vehicle controls

When the player enters a vehicle, the control layout should change to match the driving state.

Depending on the vehicle and supported mechanics, show:

- Steering controls.
- Acceleration.
- Braking and reversing.
- Enter/exit vehicle interaction where appropriate.
- Handbrake or another essential driving action if supported.
- Vehicle status such as fuel and damage when implemented.
- The microphone control.
- Other context-sensitive actions required by the vehicle.

On desktop, use the corresponding keyboard and mouse controls.

Entering and leaving vehicles must be handled by a valid server-controlled state transition. The client must not be able to claim ownership or control of an arbitrary vehicle.

### 10.4 HUD design

Use Hugeicons for consistent interface iconography.

The HUD should support:

- Current level and experience.
- Money.
- Active task or mission.
- Map/navigation.
- Notifications.
- Settings.
- Voice-chat state.
- Context-sensitive interactions.

Do not display every available status at all times. Prioritize information according to the current activity.

### 10.5 Proximity voice chat

The gameplay HUD must include a microphone button.

The expected behavior is:

- Tap once to enable the microphone.
- Tap again to mute.
- Clearly indicate whether the microphone is active or muted.
- Allow nearby players to hear the player when voice chat is active.
- Stop transmitting immediately when muted or disconnected.
- Respect browser microphone permission and device availability.

Voice transmission must be based on proximity within the authoritative game world, not simply membership in the same server.

The voice system must use a suitable real-time audio approach, such as WebRTC with an appropriate signaling and media-routing architecture. Claude Code must evaluate the expected player count, mobile browser support, bandwidth, server costs, and voice infrastructure before selecting the final implementation.

The system should prevent a muted player from transmitting and should provide a way to report or block abusive players.

If microphone permission is denied, movement and other gameplay must continue normally.

Voice chat is a core product requirement, but it should be introduced after the first playable multiplayer movement prototype proves the main networking architecture.

## 11. Vehicles and Garages

The initial vehicle system should contain **3–5 distinct vehicle models**, with different visual identities and price levels.

Possible categories include:

- Entry-level sedan.
- Sport coupe.
- Luxury sedan.
- Supercar.
- Optional luxury SUV.

These are categories, not requirements to use specific real-world manufacturers. Use original or properly licensed vehicle models and avoid unauthorized badges or copied designs.

Each model can have many individually owned vehicles.

### 11.1 Driving

Vehicles must support actual driving, steering, acceleration, braking, collision handling, and appropriate interaction with the world.

The driving experience should be responsive and believable for the intended game style.

Avoid relying entirely on client-side vehicle physics when that would allow players to teleport, accelerate impossibly, or interfere with other players. The server should validate important vehicle state and movement.

### 11.2 Ownership

Every individually owned player vehicle should have a persistent identity and be tradable on-chain using the selected Solana asset standard.

The recommended starting point is Metaplex Core, subject to a Devnet prototype and technical review.

A vehicle model is a reusable design. An individual purchased car is a separate asset with its own identity and owner.

### 11.3 Mint-on-purchase

Do not mint every possible vehicle in advance.

When a player purchases a car from the in-game dealership, the system should create the individual on-chain vehicle asset for that purchase.

The purchase flow must safely handle:

- Payment and purchase validation.
- Wallet ownership and signing.
- Mint transaction submission.
- Pending or failed transactions.
- Duplicate requests and retries.
- Final ownership verification.
- Delivery of the vehicle into the player's game account.

Do not permanently charge the player for a vehicle that was not successfully delivered. Use a recoverable purchase state and transaction reconciliation process.

The in-game vehicle price must be separate from the blockchain creation cost.

### 11.4 Dynamic vehicle state

Keep ordinary gameplay state off-chain, including:

- Fuel.
- Damage.
- Position.
- Current driver.
- Upgrades.
- Appearance modifications.
- Garage location.
- Other mutable gameplay state.

The on-chain asset represents vehicle identity and ownership. The game server remains authoritative for ordinary gameplay behavior.

### 11.5 Garages and resale

Players should be able to access vehicles they own, subject to game rules.

Future vehicle resale should transfer the existing asset rather than minting a replacement.

A marketplace must verify asset ownership, prevent duplicate listings, and reconcile payment and transfer states. Any marketplace fee or resale restriction must be designed around the actual settlement architecture; do not assume that arbitrary external NFT transfers can automatically enforce game marketplace rules.

## 12. Main City Interactions

The initial city should contain the functional locations required by the implemented systems.

Examples include:

- Job locations.
- Mining sites.
- Delivery pickup and drop-off points.
- Taxi pickup locations.
- Vehicle dealership.
- Garage.
- Police station.
- Medical facility.
- Gang-related locations.
- Tutorial destinations.
- Public spaces where players can meet and interact.

Not all locations need to be accessible indoors. Prioritize interactions that support actual gameplay.

Every implemented interaction must have a clear feedback state. Players should understand what they can interact with and what happens after the interaction.

Avoid filling the world with doors, objects, or menus that look interactive but do nothing.

## 13. Multiplayer and Social Systems

The city should feel populated by real players.

The MVP multiplayer system should support:

- Multiple players in the same world.
- Real-time player movement.
- Character appearance synchronization.
- Nearby player visibility.
- Basic player profiles.
- Proximity text chat.
- Proximity voice chat.
- Contextual interaction prompts.
- Basic emotes where practical.
- Player reporting and blocking.
- Reconnection and session recovery.

Use an authoritative server for important world state.

Clients should send inputs or proposed actions; they must not be trusted to decide their own money, rewards, job completion, inventory, faction permissions, or vehicle ownership.

Voice and text communication must follow server and moderation rules.

The first multiplayer prototype should test realistic networking conditions before expanding into a large population or complex faction systems.

## 14. Economy

The initial game should use one primary in-game currency, displayed using `$`.

The currency is a gameplay balance, not automatically a cryptocurrency or token.

Money can be earned through jobs and other implemented activities and spent on supported game purchases.

The economy should include:

- Server-controlled balances.
- Validated rewards.
- Transaction history.
- Purchase history.
- Idempotent reward processing.
- Anti-duplication and anti-exploit protections.
- Basic economic analytics.

Use a ledger-style approach for important money movements so balances can be audited and recovered if an operation fails.

Do not introduce token issuance, cash-out, or a player-facing cryptocurrency economy into the MVP.

## 15. Web3 and Authentication

### 15.1 Normal game experience first

Players should be able to create an account and play without having to understand wallets, transaction signatures, RPCs, or blockchain mechanics.

Use Privy for supported authentication and embedded wallet creation.

Wallets should be associated with the correct user account and character. Never expose private keys or store them in ordinary application databases.

### 15.2 On-chain scope

The primary MVP on-chain asset is the individually owned vehicle.

Keep the following off-chain:

- Character level and experience.
- Ordinary game money.
- Job progress.
- Inventory and ordinary items.
- Faction membership and rank.
- Fuel and vehicle damage.
- Position and movement.
- Ordinary mission state.

Future asset types may be considered after the vehicle system is reliable.

### 15.3 Solana implementation

Begin with Solana Devnet.

Prototype and verify:

- Privy wallet integration.
- Vehicle asset creation.
- Ownership verification.
- Dealership mint-on-purchase.
- Transaction failure and retry behavior.
- Existing asset transfer.
- Reconciliation between blockchain ownership and the game database.

Do not move to Mainnet until the flow has been tested, reviewed, and secured.

Do not write a custom Solana program unless the technical review identifies a requirement that the selected asset standard and settlement design cannot satisfy.

## 16. Main Navigation and Settings

The main menu and in-game UI should share a consistent visual identity.

Settings should include, where supported:

- Master volume.
- Music volume.
- Sound effects volume.
- Microphone and voice settings.
- Graphics quality.
- Control sensitivity.
- HUD or control-layout options where practical.
- Notification preferences.
- Account information.
- Logout.

Persist user preferences across sessions.

The interface should be responsive and designed for touch input first on mobile, while remaining usable on desktop.

## 17. Technical Architecture

The exact stack must be validated through a technical prototype. The following is a proposal, not a mandate.

### Frontend and rendering

- React and TypeScript for interface and application logic.
- A dedicated 3D rendering layer using Babylon.js or Three.js, selected after benchmarking.
- Optimized GLB/glTF assets where appropriate.
- PWA support for installation and browser-based delivery.
- Hugeicons for interface icons.

Do not let the React UI layer become responsible for every high-frequency 3D update. Keep rendering, game simulation, and interface state appropriately separated.

### Backend

Potential direction:

- Node.js and TypeScript.
- An authoritative real-time game server using WebSockets or a suitable game-networking protocol.
- PostgreSQL for persistent player, character, job, economy, and ownership records.
- Appropriate caching or ephemeral state storage where measurement justifies it.
- A real-time voice architecture evaluated separately from ordinary game-state networking.

A modular monolith is preferred at the start unless load testing or technical constraints justify a different approach.

### Authority and persistence

The server must own or validate:

- Character identity.
- Position and movement constraints.
- Job state.
- Money and rewards.
- Inventory.
- Faction membership and permissions.
- Vehicle ownership and important vehicle state.
- Mission progression.
- Purchases and transactions.

The renderer should visualize the authoritative world; it should not be the source of truth.

### Technical feasibility gate

Before building the full city, create a prototype containing:

1. One representative section of the intended city.
2. One optimized third-person character.
3. Basic movement and camera controls.
4. One functional drivable vehicle.
5. Basic collision handling.
6. Several networked players.
7. Initial mobile and desktop input schemes.
8. A performance measurement process.

The prototype is not the final map and must not become a substitute for the full city. Its purpose is to establish whether the proposed rendering and networking approach can support the intended game.

Claude Code must benchmark the prototype on a representative desktop and a mid-range mobile device before recommending the production architecture.

## 18. Security, Reliability, and Moderation

Requirements include:

- Server-side validation of rewards and job completion.
- Movement and vehicle sanity checks.
- Authentication and session validation.
- Secure wallet-to-account association.
- Idempotent processing for purchases and rewards.
- Transaction reconciliation for on-chain assets.
- Rate limits for sensitive actions.
- Protection against duplicate claims and replayed requests.
- Report and block functionality.
- Appropriate controls for voice and text abuse.
- Graceful handling of disconnects and reconnects.
- Logging and monitoring for important failures.

The system must not trust client-provided balances, ownership claims, faction ranks, or job outcomes.

## 19. Performance and Platform Requirements

The game should target modern desktop browsers and supported mobile browsers, with installation through PWA capabilities where available.

Requirements:

- Landscape-first mobile gameplay.
- Responsive controls and camera movement.
- Efficient asset delivery.
- Reasonable initial loading time.
- Stable multiplayer synchronization.
- Reconnection after temporary network loss.
- Graceful handling of unsupported features.
- Persistent character and account data.
- Clear loading, error, and recovery states.

Set measurable frame-rate, load-time, memory, and networking targets after the initial prototype. Do not claim a specific number of concurrent players or a guaranteed frame rate before benchmarking.

The map and asset pipeline must account for the limitations of mobile browsers, memory pressure, thermal throttling, and variable network quality.

## 20. MVP Scope and Priorities

### P0 — Core playable foundation

- Landscape orientation flow.
- Notification prompt with skip option.
- Cinematic loading screen and real loading states.
- Tap to Play interaction and audio activation.
- Login and guest entry.
- Terms and policy acceptance.
- One selectable server: Horizon.
- Main menu.
- Character creation and persistence.
- Guided tutorial with skip option.
- One complete connected city map with coherent terrain and scenery.
- Third-person movement and camera controls.
- Real-time multiplayer player visibility.
- Basic text chat and interaction prompts.
- Three casual jobs: mining, delivery courier, and taxi driver.
- Level, experience, and in-game currency systems.
- Three to five vehicle models.
- Basic driving and vehicle interactions.
- Dealership and garage foundations.
- Proximity voice chat.
- Core security, reporting, and reconnection handling.

### P1 — Faction and ownership expansion

- Police faction.
- Medical faction.
- Gang faction.
- Faction ranks and permissions.
- Additional faction-specific gameplay.
- Devnet vehicle mint-on-purchase.
- Vehicle ownership verification.
- Robust transaction recovery and reconciliation.
- Basic vehicle resale or marketplace, only after safe settlement is demonstrated.
- Expanded character customization.
- Additional missions and city interactions.

### Later — Expansion

- Additional jobs and career paths.
- More vehicles and customization.
- Expanded faction missions.
- More sophisticated NPC behavior.
- Additional interiors and interactive locations.
- Player-owned businesses.
- Property ownership or property NFTs.
- Advanced social systems.
- More elaborate economy and trading systems.
- Additional servers or larger world populations.
- Additional maps or cities.

These priorities are not a reason to reduce the initial world to a single street. The city must be planned as a complete map from the beginning, while its functional systems and accessible interiors are developed in stages.

## 21. Development Milestones

### M0 — Repository review and technical validation

- Inspect the existing codebase.
- Review the PRD for contradictions and risks.
- Benchmark the browser 3D approach.
- Validate mobile and desktop controls.
- Test basic multiplayer movement.
- Recommend the rendering, networking, asset, and hosting architecture.

**Exit condition:** A documented, tested technical plan and an approved playable-prototype scope.

### M1 — World and character foundation

- Establish the city map layout and environment pipeline.
- Implement character rendering and movement.
- Add the camera and initial collision system.
- Implement the core loading and game-entry flow.
- Establish persistent account and character records.

**Exit condition:** A player can enter a visually coherent world and control a persistent character.

### M2 — Multiplayer and onboarding

- Implement server selection.
- Complete main-menu flow.
- Complete character creation.
- Implement the tutorial and skip/resume behavior.
- Synchronize multiple players.
- Add interaction prompts and basic social functionality.

**Exit condition:** New users can create a character, complete or skip the tutorial, and meet other players.

### M3 — Jobs and progression

- Implement mining.
- Implement delivery courier work.
- Implement taxi driving.
- Add experience and levels.
- Add server-controlled money and reward records.
- Implement the necessary job locations.

**Exit condition:** Players can complete actual job activities and receive validated rewards.

### M4 — Vehicles and driving

- Integrate the initial vehicle models.
- Implement driving and vehicle state.
- Add dealership and garage functionality.
- Implement vehicle persistence.
- Optimize vehicle controls for mobile and desktop.

**Exit condition:** Players can acquire, enter, drive, and manage supported vehicles reliably.

### M5 — Factions, voice, and Web3 ownership

- Implement Police, Medical, and Gang foundations.
- Add proximity voice chat.
- Integrate Privy wallet association.
- Implement Devnet vehicle asset creation.
- Add ownership verification and transaction reconciliation.
- Review security and failure recovery.

**Exit condition:** The supported systems work together without compromising core gameplay or asset ownership.

### M6 — Closed beta and release preparation

- Test across target devices.
- Run multiplayer and performance tests.
- Test account recovery and disconnection.
- Test economy and job exploits.
- Test voice moderation.
- Validate asset licensing.
- Resolve critical issues.
- Prepare release monitoring and support processes.

**Exit condition:** The game meets its agreed acceptance criteria and has no unresolved critical issues in core flows.

Do not assign calendar estimates until M0 has established the actual technical risks and development scope.

## 22. Acceptance Criteria

The initial release should not be considered ready until the following can be demonstrated:

1. A new player can launch the game and follow the complete first-time flow.
2. Mobile users receive the landscape prompt when appropriate.
3. The loading screen reflects actual loading activity and handles failure.
4. The player can authenticate or enter through supported guest access.
5. The player can select the Horizon server.
6. A new player can create and save a character.
7. The tutorial can be completed or skipped without corrupting progression.
8. The player can freely explore one connected, visually coherent city map.
9. The environment includes defined terrain, roads, buildings, sky, lighting, shadows, and vegetation.
10. Multiple players can enter the world and see one another move.
11. The on-foot controls work on supported mobile and desktop devices.
12. The vehicle control layout changes appropriately when entering and exiting a vehicle.
13. Proximity voice chat respects microphone permissions, mute state, and proximity.
14. Mining, courier work, and taxi driving each have real gameplay mechanics.
15. Job rewards, experience, and balances are validated by the server.
16. Character level and progress persist across sessions.
17. Vehicle ownership and vehicle state persist correctly.
18. Failed or interrupted purchases cannot silently charge a player without a recoverable delivery state.
19. On-chain vehicle ownership is verified rather than trusted from client input.
20. Reports, blocking, reconnection, and critical error handling are functional.
21. Performance has been measured on representative mobile and desktop hardware.
22. The release has passed the agreed security and asset-licensing checks.

## 23. Key Risks

### Browser-based 3D performance

A large, detailed, real-time multiplayer city is demanding for a browser game, especially on mobile devices.

**Mitigation:** Benchmark the rendering engine, asset pipeline, map streaming, and multiplayer architecture early.

### World quality versus world size

A large map built entirely from low-quality or repetitive assets will not deliver the desired experience.

**Mitigation:** Define the full city layout early, use a coherent art direction, and prioritize high-quality landmarks and believable environmental composition.

### Scope and development complexity

Jobs, factions, voice, vehicles, character customization, and blockchain ownership each introduce significant implementation work.

**Mitigation:** Use milestone gates and reusable foundations without turning distinct gameplay systems into generic placeholder interactions.

### Multiplayer authority

Client-controlled rewards, movement, or vehicle state can lead to exploits and inconsistent world state.

**Mitigation:** Establish server authority and validation early.

### Voice chat complexity

Proximity voice introduces browser permission, latency, media-routing, bandwidth, and moderation requirements.

**Mitigation:** Test voice technology independently before committing to the full implementation.

### Web3 purchase failures

A blockchain transaction can be pending or fail while the game database is handling a purchase.

**Mitigation:** Use explicit transaction states, idempotency, ownership verification, and reconciliation.

### Asset licensing

Vehicles, character models, buildings, sounds, and music may carry licensing restrictions.

**Mitigation:** Use original assets or assets with licenses appropriate for commercial game distribution. Do not assume that a publicly downloadable asset is free to use.

## 24. Mandatory Instructions for Claude Code

Before implementing the full PRD:

1. Inspect the existing repository and identify its framework, architecture, dependencies, and existing functionality.
2. Restate the product direction and identify any misunderstanding.
3. Evaluate the feasibility of a OneState/GTA-style city delivered through a browser-based PWA.
4. Recommend the most appropriate rendering engine and explain the trade-offs.
5. Explain how map size, world streaming, collisions, character movement, vehicles, and multiplayer synchronization will work.
6. Propose the initial city layout and asset-production pipeline without reducing the intended city to a tiny environment.
7. Review the first-time user flow, including orientation, notifications, loading, login, server selection, character creation, and tutorial.
8. Propose the job framework while preserving the distinct mechanics of mining, courier work, and taxi driving.
9. Define how Police, Medical, and Gang factions fit into the architecture.
10. Evaluate proximity voice technology, expected infrastructure costs, and browser compatibility.
11. Review Privy and Metaplex Core integration, including failed transactions and ownership verification.
12. Separate P0, P1, and later functionality.
13. Identify major risks, testing requirements, and measurable acceptance criteria.
14. Recommend a development sequence based on actual dependencies and prototype results.
15. Maintain a concise decision log and update the project tracking document as decisions are approved.

**Do not blindly implement every sentence in this document.** Challenge technical assumptions, identify expensive or infeasible requirements, and recommend better solutions where necessary.

However, do not silently change the product direction. In particular:

- Do not revert to a Lagos-based map.
- Do not replace the city with a tiny playable environment.
- Do not remove the cinematic first-time flow.
- Do not reduce jobs to generic start/finish buttons.
- Do not replace the requested Police, Medical, and Gang factions with an organization system.
- Do not remove proximity voice chat or vehicle-specific controls without explaining the technical reason and proposing a practical plan.
- Do not turn the normal game experience into a wallet-first Web3 interface.

Review first, explain the trade-offs, and identify what needs approval before major implementation begins.

---

**End of PRD**
