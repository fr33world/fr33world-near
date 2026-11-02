# Horizon world server: load test results (prototype, 2026-10-28)

**Goal (technical plan §6, decision D-21):** 500 players on one server at a 30 Hz snapshot rate, with at most about 25 KB/s down per player, and no false corrections for honest players on poor networks.

## Setup

|                   |                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Machine           | MacBook, Intel i7-5650U (2015, 2 cores / 4 threads, 2.2 GHz), 8 GB RAM, macOS 12. The server and all bots run on this machine.                                           |
| Server            | `apps/world`, one Node 24 process: 30 Hz tick, tiered area-of-interest updates (16 nearest at 30 Hz, 64 at 15 Hz, 128 at 5 Hz, kept until rank 160), movement validation |
| Bots              | `apps/world/src/load`: 500 headless clients in 2 worker threads. Each sends its pose at 20 Hz and pings every 2 s.                                                       |
| Simulated network | 75 ms each way (150 ms RTT), ±15 ms jitter, 2% loss (modelled as 200 ms TCP retransmit stalls)                                                                           |
| Scenarios         | **spread**: bots run the street grid of the 520 × 500 m block. **crowd**: all 500 mill around the spawn plaza (worst case).                                              |
| Run               | `BOTS=500 SCENARIO=spread TRANSPORT=uws pnpm load` (ramp 50 bots/s, then a 40 s steady window)                                                                           |

## Results

### World logic alone (in-process, no network): `node src/load/bench-step.ts`

| Version                                          | spread p50 / p95   | crowd p50 / p95    |
| ------------------------------------------------ | ------------------ | ------------------ |
| First version                                    | 38.2 / 44.9 ms     | 38.4 / 56.8 ms     |
| + typed-array entity mirrors, compact views      | 28.6 / 36.0 ms     | 30.0 / 51.8 ms     |
| + no allocation per snapshot entity              | 21.8 / 30.7 ms     | 22.2 / 29.8 ms     |
| + views rebuilt at 10 Hz, light 30 Hz refresh    | 11.9 / 18.0 ms     | 11.9 / 16.0 ms     |
| + one frame per client per tick, rank hysteresis | **12.6 / 25.7 ms** | **13.1 / 29.2 ms** |

At 500 players the world needs about 13 ms of a 33 ms tick on this 2015 laptop CPU.

### End to end, 500 bots over WebSockets on the same laptop

| Transport, scenario          | Tick rate   | Tick p50 / p99 | Server CPU / RSS | Down per player | Frames/s per player | RTT p50 / p95 | False corrections |
| ---------------------------- | ----------- | -------------- | ---------------- | --------------- | ------------------- | ------------- | ----------------- |
| ws, spread (first version)   | 9.1 Hz      | 59 / 281 ms    | 71% / 156 MB     | 7.2 KB/s        | 23.9                | 223 / 421 ms  | 0                 |
| uws, spread (first version)  | 8.4 Hz      | 79 / 301 ms    | 64% / 159 MB     | 6.7 KB/s        | 23.8                | 231 / 448 ms  | 0                 |
| uws, crowd (before batching) | 9.4 Hz      | 55 / 257 ms    | 49% / 86 MB      | 8.1 KB/s        | 51.2                | 242 / 446 ms  | 0                 |
| **ws, spread (final)**       | 20.9 Hz     | 30 / 130 ms    | 64% / 144 MB     | 16.2 KB/s       | 21.2                | 194 / 387 ms  | 0                 |
| **uws, spread (final)**      | **22.2 Hz** | **30 / 86 ms** | 67% / 148 MB     | 16.6 KB/s       | 21.9                | 193 / 385 ms  | 0                 |
| **uws, crowd (final)**       | 17.6 Hz     | 32 / 209 ms    | 58% / 148 MB     | 14.1 KB/s       | 18.3                | 199 / 393 ms  | 0                 |

RTT includes the 150 ms simulated network.

## What this shows

- **The world logic fits 500 players.** It takes about 13 ms of each 33 ms tick on a 2015 dual-core laptop CPU. A current server core is roughly twice as fast.
- **The laptop can't show the full 30 Hz end to end.** Profiling the server under load showed 38% of its time inside socket `send`: about 15,000 loopback writes per second, which are expensive on macOS. The 500 bots also take CPU from the same two cores, so the server process only got about 60% of a core. This is a limit of the test machine, not a design limit, but it **has to be confirmed on a Linux VM with the bots on a separate machine** before the 500-player target counts as proven.
- **Bandwidth is within target:** 14–17 KB/s down per player with 500 online, against a target of ≤ 25 KB/s.
- **Validation is safe for honest players:** zero corrections across about 1.5 million pose reports under 150 ms RTT, jitter and 2% loss.
- **Crowds were the worst case and are now handled.** Rank hysteresis and one frame per client per tick cut a crowd's frames from 51 to 18 per second per player.

## Decision D-25: WebSocket library

**`uWebSockets.js` for production.** Against `ws` it had a higher tick rate under load (22.2 vs 20.9 Hz) and a much better tail (p99 tick 86 vs 130 ms).

- **Kept as fallback:** `ws` stays as a drop-in behind the same `Transport` interface, chosen with `TRANSPORT=ws`. Tests use neither.
- **Caveat:** `uWebSockets.js` installs from GitHub as a native addon. Release v20.71.0 ships a broken ESM wrapper, so the server loads its CommonJS entry; see `transport-uws.ts`. Pin versions and re-check on each upgrade.

## Next

1. Rerun on a Linux VM in the target region (Western Europe), with the bots on a second machine. That confirms 30 Hz at 500 players and gives the VM size to rent.
2. If 30 Hz still isn't met there, move snapshot encoding and sending into worker threads that share entity state.
