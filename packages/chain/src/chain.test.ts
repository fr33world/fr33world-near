import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { describe, expect, it } from 'vitest';
import { chainConfig, explorerUrl } from './config.ts';
import { authorityFromEnv, carAssetKeypair, collectionKeypair, encodeSecret } from './keys.ts';

describe('chainConfig', () => {
  it('defaults to Devnet and its public endpoint', () => {
    expect(chainConfig({})).toEqual({ cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com' });
    expect(chainConfig({ SOLANA_RPC_URL: 'http://127.0.0.1:8899' }).rpcUrl).toBe(
      'http://127.0.0.1:8899',
    );
  });

  it('refuses Mainnet without the explicit go-live flag', () => {
    expect(() => chainConfig({ SOLANA_CLUSTER: 'mainnet-beta' })).toThrow(/CHAIN_ALLOW_MAINNET/);
    expect(
      chainConfig({ SOLANA_CLUSTER: 'mainnet-beta', CHAIN_ALLOW_MAINNET: 'yes' }).cluster,
    ).toBe('mainnet-beta');
    expect(() => chainConfig({ SOLANA_CLUSTER: 'testnet' })).toThrow(/unknown/);
  });

  it('links the explorer on the right cluster', () => {
    expect(explorerUrl(chainConfig({}), 'tx', 'abc')).toBe(
      'https://explorer.solana.com/tx/abc?cluster=devnet',
    );
  });
});

describe('derived addresses', () => {
  const umi = createUmi('http://127.0.0.1:8899');
  const authority = umi.eddsa.generateKeypair();

  it('gives each car one stable address, so a retried mint finds the first one', () => {
    const a = carAssetKeypair(umi, authority, '42').publicKey;
    expect(carAssetKeypair(umi, authority, '42').publicKey).toBe(a);
    expect(carAssetKeypair(umi, authority, '43').publicKey).not.toBe(a);
    expect(collectionKeypair(umi, authority).publicKey).not.toBe(a);
  });

  it("differs per game authority, so nobody else can predict a car's address", () => {
    const other = umi.eddsa.generateKeypair();
    expect(carAssetKeypair(umi, other, '42').publicKey).not.toBe(
      carAssetKeypair(umi, authority, '42').publicKey,
    );
  });

  it('round-trips the authority secret through the environment', () => {
    const loaded = authorityFromEnv(umi, { CHAIN_AUTHORITY_SECRET: encodeSecret(authority) });
    expect(loaded?.publicKey).toBe(authority.publicKey);
    expect(authorityFromEnv(umi, {})).toBeNull();
  });
});
