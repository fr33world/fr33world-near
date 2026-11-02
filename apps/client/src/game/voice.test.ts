import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { entityOfIdentity, Voice, voiceVolume } from './voice.ts';

describe('voice volume', () => {
  it('is full up close and silent at the edge of earshot', () => {
    expect(voiceVolume(1)).toBe(1);
    expect(voiceVolume(20)).toBeGreaterThan(0.2);
    expect(voiceVolume(20)).toBeLessThan(0.4);
    expect(voiceVolume(40)).toBe(0);
    expect(voiceVolume(400)).toBe(0);
  });

  it('maps voice identities to entity ids', () => {
    expect(entityOfIdentity('p42')).toBe(42);
    expect(entityOfIdentity('admin')).toBe(-1);
  });
});

/** Just enough of a LiveKit room for Voice.update. */
function fakeRoom(ids: number[]) {
  const people = ids.map((id) => {
    const pub = {
      isSubscribed: false,
      setSubscribed(on: boolean) {
        this.isSubscribed = on;
      },
    };
    return {
      identity: `p${id}`,
      volume: 1,
      pub,
      audioTrackPublications: new Map([['mic', pub]]),
      setVolume(v: number) {
        this.volume = v;
      },
    };
  });
  // Who our mic is open to (publisher permissions), as last set.
  const allowed: { list: string[] | null } = { list: null };
  return {
    people,
    allowed,
    remoteParticipants: new Map(people.map((p) => [p.identity, p])),
    localParticipant: {
      setTrackSubscriptionPermissions: (all: boolean, list: { participantIdentity: string }[]) => {
        allowed.list = all ? null : list.map((x) => x.participantIdentity);
      },
    },
  };
}

describe('earshot', () => {
  it('runs its first check even when the page clock has only just started (fresh CI worker)', () => {
    const voice = new Voice();
    const room = fakeRoom([1]);
    (voice as unknown as { room: unknown }).room = room;
    const real = performance.now.bind(performance);
    performance.now = () => 10;
    try {
      voice.update(new THREE.Vector3(), () => new THREE.Vector3(2, 0, 0));
    } finally {
      performance.now = real;
    }
    expect(room.people[0]?.pub.isSubscribed).toBe(true);
  });

  it('subscribes to near voices only, and drops them past the edge with some slack', () => {
    const voice = new Voice();
    const room = fakeRoom([1, 2, 3]);
    const internals = voice as unknown as { room: unknown; lastUpdate: number };
    internals.room = room;
    const at: Record<number, THREE.Vector3> = {
      1: new THREE.Vector3(5, 0, 0),
      2: new THREE.Vector3(80, 0, 0),
      3: new THREE.Vector3(44, 0, 0),
    };
    const update = () => {
      internals.lastUpdate = -Infinity;
      voice.update(new THREE.Vector3(), (id) => at[id] ?? null);
    };
    update();
    const [near, far, edge] = room.people;
    expect(near?.pub.isSubscribed).toBe(true);
    expect(near?.volume).toBeGreaterThan(0.8);
    expect(far?.pub.isSubscribed).toBe(false);
    // 44 m: not picked up (outside 40 m)...
    expect(edge?.pub.isSubscribed).toBe(false);
    // ...but once heard at 30 m, still kept at 44 m (dropped only past 48 m).
    at[3] = new THREE.Vector3(30, 0, 0);
    update();
    at[3] = new THREE.Vector3(44, 0, 0);
    update();
    expect(edge?.pub.isSubscribed).toBe(true);
    at[3] = new THREE.Vector3(60, 0, 0);
    update();
    expect(edge?.pub.isSubscribed).toBe(false);
    // Someone who left the view (no position) is dropped.
    delete at[1];
    update();
    expect(near?.pub.isSubscribed).toBe(false);
    // Our mic is open only to those in earshot (the server enforces it): nobody now.
    expect(room.allowed.list).toEqual([]);
    at[2] = new THREE.Vector3(10, 0, 0);
    update();
    expect(room.allowed.list).toEqual(['p2']);
  });
});
