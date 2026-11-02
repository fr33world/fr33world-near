/**
 * Proximity voice (decision D-10) over LiveKit. The world server hands each player a pass for
 * one shared room; everyone's identity is their entity id ("p42"). Nobody is subscribed by
 * default: a few times a second this subscribes to the voices of players within HEAR_RADIUS
 * and drops the rest, with volume falling off by distance. So you only hear, and only
 * download, the people around you.
 *
 * Earshot is enforced, not just chosen (Phase 10): each player's client tells LiveKit who may
 * subscribe to its own microphone (publisher permissions, which the server enforces): only the
 * players within DROP_RADIUS who aren't muted or blocked. So a tampered client can't listen
 * in from across the city; at worst it lets more people hear its own voice.
 *
 * Push to talk: hold V on desktop; the mic button toggles on touch. The microphone needs a
 * secure page (HTTPS or localhost): phones on the dev server's LAN address have no voice.
 * The LiveKit library loads only when the first pass arrives.
 */
import type { Participant, RemoteParticipant, Room } from 'livekit-client';
import type * as THREE from 'three';
import { settings } from './settings.ts';

const HEAR_RADIUS = 40;
/** Drop a voice a little further out than we pick it up, so it doesn't flicker at the edge. */
const DROP_RADIUS = 48;
/** Full volume this close. */
const NEAR = 3;
const UPDATE_MS = 250;

export type VoiceState = 'off' | 'connecting' | 'on' | 'unavailable';

/** Volume for a voice `d` metres away: full up close, fading to silence at HEAR_RADIUS. */
export function voiceVolume(d: number): number {
  const t = Math.min(1, Math.max(0, (d - NEAR) / (HEAR_RADIUS - NEAR)));
  return (1 - t) * (1 - t);
}

/** Entity id from a voice identity ("p42" → 42), or -1. */
/** Safari on iPhone and iPad (every browser there is), where element volume can't be set. */
function appleWebKit(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function entityOfIdentity(identity: string): number {
  return /^p\d+$/.test(identity) ? Number(identity.slice(1)) : -1;
}

export class Voice {
  state: VoiceState = 'off';
  talking = false;
  /** Voices currently subscribed (people in earshot who are publishing). */
  hearing = 0;
  /** Entity ids speaking right now (for HUD and name tags). */
  readonly speaking = new Set<number>();

  private room: Room | null = null;
  private micOn = false;
  private micBusy = false;
  // -Infinity, not 0: performance.now() starts near 0, and the first update must run.
  private lastUpdate = -Infinity;
  private unlockAudio: (() => void) | null = null;

  static available(): boolean {
    return (
      window.isSecureContext &&
      navigator.mediaDevices !== undefined &&
      'getUserMedia' in navigator.mediaDevices
    );
  }

  async connect(url: string, token: string): Promise<void> {
    if (!Voice.available()) {
      this.state = 'unavailable';
      return;
    }
    await this.disconnect();
    this.state = 'connecting';
    const lk = await import('livekit-client');
    const room = new lk.Room({
      adaptiveStream: false,
      dynacast: true,
      // Per-voice volume through Web Audio only where it's needed: element volume is fixed on
      // iOS Safari. Elsewhere voices play through audio elements, because Chromium's echo
      // cancellation ignores Web Audio output: the mic picked up others' voices from the
      // speakers and played them back to them.
      webAudioMix: appleWebKit(),
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    room.on(lk.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === lk.Track.Kind.Audio) track.attach();
    });
    room.on(lk.RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
    });
    room.on(lk.RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      this.speaking.clear();
      for (const s of speakers) {
        const id = entityOfIdentity(s.identity);
        if (id >= 0) this.speaking.add(id);
      }
    });
    room.on(lk.RoomEvent.Disconnected, () => {
      if (this.room === room) this.state = 'off';
    });
    try {
      await room.connect(url, token, { autoSubscribe: false });
    } catch (e) {
      this.state = 'off';
      console.warn('voice: could not connect', e);
      return;
    }
    this.room = room;
    this.state = 'on';
    // Browsers only play audio after a tap or key press.
    const unlock = () => void room.startAudio();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.unlockAudio = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }

  async disconnect(): Promise<void> {
    this.unlockAudio?.();
    this.unlockAudio = null;
    const room = this.room;
    this.room = null;
    this.micOn = false;
    this.talking = false;
    this.hearing = 0;
    this.speaking.clear();
    if (this.state !== 'unavailable') this.state = 'off';
    await room?.disconnect();
  }

  /** Push to talk. The first press asks for the microphone. */
  setTalking(on: boolean): void {
    this.talking = on && this.state === 'on';
    const room = this.room;
    if (!room || this.micBusy || this.micOn === this.talking) return;
    this.micBusy = true;
    const want = this.talking;
    // iPhone: recording needs a recording session; back to playback after, or the game's sound
    // stays quiet on the earpiece.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = want ? 'play-and-record' : 'playback';
    room.localParticipant
      .setMicrophoneEnabled(want)
      .then(
        () => (this.micOn = want),
        (e: unknown) => console.warn('voice: microphone', e),
      )
      .finally(() => (this.micBusy = false));
  }

  /**
   * Subscribes to voices in earshot of `listener` and sets their volume. `positionOf` gives
   * an entity's position, or null when it isn't in view.
   */
  /** Players (entity ids) this player has muted: never heard. */
  readonly muted = new Set<number>();

  update(listener: THREE.Vector3, positionOf: (id: number) => THREE.Vector3 | null): void {
    const room = this.room;
    const now = performance.now();
    if (!room || now - this.lastUpdate < UPDATE_MS) return;
    this.lastUpdate = now;
    let hearing = 0;
    const allowed: string[] = [];
    for (const p of room.remoteParticipants.values()) {
      const id = entityOfIdentity(p.identity);
      const pos = positionOf(id);
      // Muted (by this player, for this session): as if out of earshot, never subscribed.
      const d = pos && !this.muted.has(id) ? pos.distanceTo(listener) : Infinity;
      this.fit(p, d);
      if (d < DROP_RADIUS && p.audioTrackPublications.size > 0) hearing += 1;
      if (d < DROP_RADIUS) allowed.push(p.identity);
    }
    this.hearing = hearing;
    this.allow(room, allowed);
  }

  /** Who may hear our mic: only those in earshot (LiveKit enforces it), when that changes. */
  private allow(room: Room, identities: string[]) {
    const key = identities.sort().join(',');
    if (key === this.allowedKey) return;
    this.allowedKey = key;
    room.localParticipant.setTrackSubscriptionPermissions(
      false,
      identities.map((participantIdentity) => ({ participantIdentity, allowAll: true })),
    );
  }
  private allowedKey: string | null = null;

  private fit(p: RemoteParticipant, d: number) {
    for (const pub of p.audioTrackPublications.values()) {
      if (!pub.isSubscribed && d < HEAR_RADIUS) pub.setSubscribed(true);
      else if (pub.isSubscribed && d > DROP_RADIUS) pub.setSubscribed(false);
    }
    // Distance, then the player's voice and master levels (settings).
    const { voice, master } = settings();
    p.setVolume(voiceVolume(d) * voice * master);
  }
}
