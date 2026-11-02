/**
 * Proximity voice passes (decision D-10): a short-lived LiveKit token per player, for one
 * shared room. The participant identity is the player's entity id ("p42"), so clients can
 * match each voice to the body they see and hear only the people near them.
 *
 * Environment: LIVEKIT_URL (what clients connect to), LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
 * Local development uses `livekit-server --dev` (devkey / secret); production, LiveKit Cloud.
 */
import { AccessToken } from 'livekit-server-sdk';

export const VOICE_ROOM = 'horizon';
const PASS_TTL = '6h';

export interface VoicePass {
  url: string;
  token: string;
}

export type VoiceIssuer = (entityId: number, name: string) => Promise<VoicePass>;

export function liveKitVoice(url: string, apiKey: string, apiSecret: string): VoiceIssuer {
  return async (entityId, name) => {
    const at = new AccessToken(apiKey, apiSecret, {
      identity: voiceIdentity(entityId),
      name,
      ttl: PASS_TTL,
    });
    at.addGrant({
      room: VOICE_ROOM,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    return { url, token: await at.toJwt() };
  };
}

export const voiceIdentity = (entityId: number) => `p${entityId}`;
