/**
 * Car ownership certificates on Solana as Metaplex Core assets (decisions D-09, D-22).
 *
 * Each car is minted into its owner's wallet but **frozen** by a permanent freeze delegate the
 * game holds, so it can't be sold or sent outside the game. A permanent transfer delegate,
 * also the game's, moves it when an in-game trade (settled in `$`) completes: permanent
 * plugins override the freeze. Both can only be set at creation and can't be removed by the
 * owner.
 *
 * Every write is idempotent, so the chain worker can retry blindly after a timeout:
 * - mint: the asset address is derived from the car id (keys.ts); an existing asset means done;
 * - transfer: a car already owned by the recipient means done.
 */
import {
  create,
  createCollection,
  fetchAssetV1,
  mplCore,
  safeFetchAssetV1,
  safeFetchCollectionV1,
  transfer,
} from '@metaplex-foundation/mpl-core';
import {
  createSignerFromKeypair,
  type Keypair,
  keypairIdentity,
  publicKey,
  type Signer,
  type Umi,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { type ChainConfig, chainConfig } from './config.ts';
import { authorityFromEnv, carAssetKeypair, collectionKeypair } from './keys.ts';

export interface CarMint {
  carId: string;
  /** The owner's wallet (their embedded Privy wallet). */
  owner: string;
  name: string;
  /** Public JSON metadata (name, image, attributes). */
  uri: string;
  model: string;
}

export interface CarOnChain {
  asset: string;
  owner: string;
  frozen: boolean;
  /** The game holds the permanent transfer and freeze delegates. */
  gameControlled: boolean;
}

export type WriteResult =
  { status: 'done'; asset: string; signature: string } | { status: 'already'; asset: string };

export class CarRegistry {
  readonly umi: Umi;
  private readonly authority: Signer;
  private readonly authorityKeypair: Keypair;
  private collectionReady: Promise<string> | null = null;

  constructor(cfg: ChainConfig, authority: Keypair) {
    this.umi = createUmi(cfg.rpcUrl, 'confirmed').use(mplCore()).use(keypairIdentity(authority));
    this.authorityKeypair = authority;
    this.authority = createSignerFromKeypair(this.umi, authority);
  }

  get authorityAddress(): string {
    return this.authority.publicKey;
  }

  carAddress(carId: string): string {
    return carAssetKeypair(this.umi, this.authorityKeypair, carId).publicKey;
  }

  /** The "Los Soles Motors" collection every car belongs to (created once). */
  collection(): Promise<string> {
    this.collectionReady ??= (async () => {
      const signer = createSignerFromKeypair(
        this.umi,
        collectionKeypair(this.umi, this.authorityKeypair),
      );
      if (!(await safeFetchCollectionV1(this.umi, signer.publicKey))) {
        await createCollection(this.umi, {
          collection: signer,
          name: 'Los Soles Motors',
          uri: 'https://fr33worldgame.xyz/nft/collection.json',
        }).sendAndConfirm(this.umi);
      }
      return signer.publicKey;
    })();
    this.collectionReady.catch(() => (this.collectionReady = null));
    return this.collectionReady;
  }

  async mint(car: CarMint): Promise<WriteResult> {
    const assetSigner = createSignerFromKeypair(
      this.umi,
      carAssetKeypair(this.umi, this.authorityKeypair, car.carId),
    );
    const existing = await safeFetchAssetV1(this.umi, assetSigner.publicKey);
    if (existing) return { status: 'already', asset: assetSigner.publicKey };
    const collection = await this.collection();
    const game = { type: 'Address' as const, address: this.authority.publicKey };
    const { signature } = await create(this.umi, {
      asset: assetSigner,
      collection: { publicKey: publicKey(collection) },
      owner: publicKey(car.owner),
      name: car.name,
      uri: car.uri,
      plugins: [
        { type: 'PermanentFreezeDelegate', frozen: true, authority: game },
        { type: 'PermanentTransferDelegate', authority: game },
        {
          type: 'Attributes',
          attributeList: [
            { key: 'carId', value: car.carId },
            { key: 'model', value: car.model },
          ],
        },
      ],
    }).sendAndConfirm(this.umi);
    return { status: 'done', asset: assetSigner.publicKey, signature: sig(signature) };
  }

  /** Moves a car to `to` as the game (an in-game trade settled). */
  async transfer(carId: string, to: string): Promise<WriteResult> {
    const address = this.carAddress(carId);
    const asset = await fetchAssetV1(this.umi, publicKey(address));
    if (asset.owner === to) return { status: 'already', asset: address };
    const collection = await this.collection();
    const { signature } = await transfer(this.umi, {
      asset,
      collection: { publicKey: publicKey(collection) },
      newOwner: publicKey(to),
      authority: this.authority,
    }).sendAndConfirm(this.umi);
    return { status: 'done', asset: address, signature: sig(signature) };
  }

  async read(carId: string): Promise<CarOnChain | null> {
    const asset = await safeFetchAssetV1(this.umi, publicKey(this.carAddress(carId)));
    if (!asset) return null;
    const game = this.authority.publicKey;
    const freeze = asset.permanentFreezeDelegate;
    const move = asset.permanentTransferDelegate;
    return {
      asset: asset.publicKey,
      owner: asset.owner,
      frozen: freeze?.frozen ?? false,
      gameControlled:
        freeze?.authority.type === 'Address' &&
        freeze.authority.address === game &&
        move?.authority.type === 'Address' &&
        move.authority.address === game,
    };
  }
}

function sig(signature: Uint8Array): string {
  return base58.deserialize(signature)[0];
}

/**
 * The game's registry from the environment (SOLANA_CLUSTER, SOLANA_RPC_URL,
 * CHAIN_AUTHORITY_SECRET), or null when no authority is set (the API's queue then waits).
 */
export function registryFromEnv(
  env: Record<string, string | undefined> = process.env,
): CarRegistry | null {
  if (!env.CHAIN_AUTHORITY_SECRET) return null;
  const cfg = chainConfig(env);
  const authority = authorityFromEnv(createUmi(cfg.rpcUrl), env);
  return authority ? new CarRegistry(cfg, authority) : null;
}
