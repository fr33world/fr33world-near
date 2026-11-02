/**
 * Phase 0 Devnet spike (track.md): proves car ownership on Solana works the way the game
 * needs before anything is built on it.
 *   pnpm --filter @fr33world/chain spike
 * 1. mints a car to a player's wallet, frozen and controlled by the game;
 * 2. the player can't move it themselves (the freeze holds);
 * 3. the game moves it to another player (an in-game sale settling);
 * 4. retried mint and transfer change nothing (idempotent).
 * Creates a Devnet-only game authority in the root .env (CHAIN_AUTHORITY_SECRET) on first run
 * and funds it from the Devnet faucet.
 */
import { appendFileSync } from 'node:fs';
import { create, fetchAssetV1, transfer } from '@metaplex-foundation/mpl-core';
import { createSignerFromKeypair, generateSigner, publicKey, sol } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { CarRegistry } from './cars.ts';
import { chainConfig, explorerUrl } from './config.ts';
import { authorityFromEnv, encodeSecret } from './keys.ts';

const cfg = chainConfig();
if (cfg.cluster !== 'devnet') throw new Error('the spike only runs on devnet');

const bootstrap = createUmi(cfg.rpcUrl);
let authority = authorityFromEnv(bootstrap);
if (!authority) {
  authority = bootstrap.eddsa.generateKeypair();
  const envFile = new URL('../../../.env', import.meta.url);
  appendFileSync(
    envFile,
    `\n# Devnet game authority for car certificates (created by the chain spike; Devnet only).\nCHAIN_AUTHORITY_SECRET=${encodeSecret(authority)}\n`,
  );
  console.log('created a Devnet game authority and saved it to .env');
}
const cars = new CarRegistry(cfg, authority);
const umi = cars.umi;
const step = (n: number, text: string) => console.log(`\n${n}. ${text}`);

console.log(`authority ${cars.authorityAddress}  (${cfg.rpcUrl})`);
const balance = await umi.rpc.getBalance(publicKey(cars.authorityAddress));
console.log(`balance ${Number(balance.basisPoints) / 1e9} SOL`);
if (balance.basisPoints < sol(0.2).basisPoints) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await umi.rpc.airdrop(publicKey(cars.authorityAddress), sol(1));
      console.log('airdropped 1 SOL');
      break;
    } catch (e) {
      if (attempt >= 3) {
        throw new Error(
          `Devnet faucet refused. Fund ${cars.authorityAddress} at https://faucet.solana.com and rerun.`,
          { cause: e },
        );
      }
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
}

const start = await umi.rpc.getBalance(publicKey(cars.authorityAddress));
const alice = generateSigner(umi);
const bob = generateSigner(umi);
const carId = `spike-${Date.now().toString(36)}`;
const checks: [string, boolean][] = [];

step(1, `mint car ${carId} to Alice (${alice.publicKey})`);
const minted = await cars.mint({
  carId,
  owner: alice.publicKey,
  name: 'Los Soles Sol Taxi',
  uri: 'https://fr33worldgame.xyz/nft/cars/sol-taxi.json',
  model: 'sol-taxi',
});
console.log(
  minted.status,
  minted.asset,
  minted.status === 'done' ? explorerUrl(cfg, 'tx', minted.signature) : '',
);
const afterMint = await cars.read(carId);
console.log(afterMint);
checks.push(['minted to Alice', afterMint?.owner === alice.publicKey]);
checks.push(['frozen in her wallet', afterMint?.frozen === true]);
checks.push(['game holds the permanent delegates', afterMint?.gameControlled === true]);

step(2, 'Alice tries to send it to Bob herself');
try {
  const asset = await fetchAssetV1(umi, publicKey(minted.asset));
  await transfer(umi, {
    asset,
    collection: { publicKey: publicKey(await cars.collection()) },
    newOwner: bob.publicKey,
    authority: createSignerFromKeypair(umi, alice),
  }).sendAndConfirm(umi);
  checks.push(['owner transfer refused', false]);
  console.log('UNEXPECTED: the transfer went through');
} catch (e) {
  const reason = String((e as Error).message).split('\n')[0];
  console.log(`refused as expected: ${reason}`);
  checks.push(['owner transfer refused', true]);
}

// Control: the same car without the game's freeze. Alice can send this one, so the refusal
// above is the freeze working, not a mistake in how she signed.
step(2.5, 'control: Alice sends an unfrozen car herself');
const control = generateSigner(umi);
await create(umi, {
  asset: control,
  collection: { publicKey: publicKey(await cars.collection()) },
  owner: alice.publicKey,
  name: 'Control car',
  uri: 'https://fr33worldgame.xyz/nft/cars/sol-taxi.json',
}).sendAndConfirm(umi);
try {
  await transfer(umi, {
    asset: await fetchAssetV1(umi, control.publicKey),
    collection: { publicKey: publicKey(await cars.collection()) },
    newOwner: bob.publicKey,
    authority: alice,
  }).sendAndConfirm(umi);
  console.log('went through');
  checks.push(['control: an unfrozen car moves when its owner signs', true]);
} catch (e) {
  console.log(`control failed: ${String((e as Error).message).split('\n')[0]}`);
  checks.push(['control: an unfrozen car moves when its owner signs', false]);
}

step(3, 'the game moves it to Bob (an in-game sale settling)');
const moved = await cars.transfer(carId, bob.publicKey);
console.log(moved.status, moved.status === 'done' ? explorerUrl(cfg, 'tx', moved.signature) : '');
const afterMove = await cars.read(carId);
console.log(afterMove);
checks.push(['now owned by Bob', afterMove?.owner === bob.publicKey]);
checks.push(['still frozen for Bob', afterMove?.frozen === true]);

step(4, 'retries change nothing');
const mintAgain = await cars.mint({
  carId,
  owner: alice.publicKey,
  name: 'Los Soles Sol Taxi',
  uri: 'https://fr33worldgame.xyz/nft/cars/sol-taxi.json',
  model: 'sol-taxi',
});
const moveAgain = await cars.transfer(carId, bob.publicKey);
console.log(`mint retry: ${mintAgain.status}, transfer retry: ${moveAgain.status}`);
checks.push([
  'mint retry is a no-op',
  mintAgain.status === 'already' && mintAgain.asset === minted.asset,
]);
checks.push(['transfer retry is a no-op', moveAgain.status === 'already']);

console.log(`\nasset ${explorerUrl(cfg, 'address', minted.asset)}`);
console.log(`collection ${explorerUrl(cfg, 'address', await cars.collection())}`);
console.log('\nresults');
for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
const end = await umi.rpc.getBalance(publicKey(cars.authorityAddress));
const spent = Number(start.basisPoints - end.basisPoints) / 1e9;
console.log(`the game paid ${spent.toFixed(5)} SOL in fees and rent for this run`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
