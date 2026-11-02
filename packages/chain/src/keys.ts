/**
 * The game's on-chain authority and the addresses derived from it.
 *
 * Every car's asset address is derived from the authority's secret and the car's id, so a
 * retried mint lands on the same address: if the first attempt went through, the retry finds
 * the asset and stops instead of minting a second car (idempotent minting).
 */
import { createHmac } from 'node:crypto';
import type { Keypair, Umi } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';

/** CHAIN_AUTHORITY_SECRET: the authority's 64-byte secret key in base58 (server-only). */
export function authorityFromEnv(
  umi: Umi,
  env: Record<string, string | undefined> = process.env,
): Keypair | null {
  const secret = env.CHAIN_AUTHORITY_SECRET;
  if (!secret) return null;
  const bytes = base58.serialize(secret);
  if (bytes.length !== 64) throw new Error('CHAIN_AUTHORITY_SECRET must be a 64-byte key');
  return umi.eddsa.createKeypairFromSecretKey(bytes);
}

export function encodeSecret(kp: Keypair): string {
  return base58.deserialize(kp.secretKey)[0];
}

/** 32 bytes that only the authority can produce for `label` (e.g. "car:42"). */
export function derivedSeed(authority: Keypair, label: string): Uint8Array {
  return new Uint8Array(
    createHmac('sha256', Buffer.from(authority.secretKey)).update(`fr33world:${label}`).digest(),
  );
}

/** The keypair whose address is car `carId`'s asset account. */
export function carAssetKeypair(umi: Umi, authority: Keypair, carId: string): Keypair {
  return umi.eddsa.createKeypairFromSeed(derivedSeed(authority, `car:${carId}`));
}

export function collectionKeypair(umi: Umi, authority: Keypair): Keypair {
  return umi.eddsa.createKeypairFromSeed(derivedSeed(authority, 'collection:cars'));
}
