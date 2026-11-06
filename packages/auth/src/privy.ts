/**
 * Privy access-token verification (PRD §15.1: Privy for authentication). The token is a
 * short-lived JWT signed by Privy; verifying it proves which Privy user is calling without
 * trusting anything the client says. Server-only: needs the app secret.
 */
import { PrivyClient } from '@privy-io/node';

/**
 * Whether a Privy user is a guest (signed in with no email or social account yet), or null
 * when Privy can't be asked. Access tokens don't say, so this looks the user up; logins only.
 * A guest who links an account stays the same user and stops being a guest.
 */
export function privyGuestCheck(
  appId: string,
  appSecret: string,
): (userId: string) => Promise<boolean | null> {
  const privy = new PrivyClient({ appId, appSecret });
  return async (userId) => {
    try {
      return (await privy.users()._get(userId)).is_guest;
    } catch {
      return null;
    }
  };
}

/** The user's embedded Solana wallet address (their car certificates go there), or null. */
export function privyWallet(
  appId: string,
  appSecret: string,
): (userId: string) => Promise<string | null> {
  const privy = new PrivyClient({ appId, appSecret });
  return async (userId) => {
    try {
      const user = await privy.users()._get(userId);
      for (const a of user.linked_accounts as {
        type?: string;
        chain_type?: string;
        address?: string;
      }[])
        if (a.type === 'wallet' && a.chain_type === 'solana' && a.address) return a.address;
      return null;
    } catch {
      return null;
    }
  };
}

/** The user's embedded NEAR wallet (an implicit account), read from Privy, never the client. */
export function privyNearWallet(
  appId: string,
  appSecret: string,
): (userId: string) => Promise<string | null> {
  const privy = new PrivyClient({ appId, appSecret });
  return async (userId) => {
    try {
      const user = await privy.users()._get(userId);
      for (const a of user.linked_accounts as {
        type?: string;
        chain_type?: string;
        address?: string;
      }[])
        if (a.type === 'wallet' && a.chain_type === 'near' && a.address) return a.address;
      return null;
    } catch {
      return null;
    }
  };
}

/** Returns the Privy user id ("did:privy:…") for a valid token of this app, else null. */
export function privyVerifier(
  appId: string,
  appSecret: string,
): (token: string) => Promise<string | null> {
  const privy = new PrivyClient({ appId, appSecret });
  return async (token) => {
    try {
      const claims = await privy.utils().auth().verifyAccessToken(token);
      return claims.app_id === appId ? claims.user_id : null;
    } catch {
      return null;
    }
  };
}
