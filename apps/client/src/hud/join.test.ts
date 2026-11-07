import { describe, expect, it } from 'vitest';
import type { FactionStatus } from '../game/api.ts';
import { joinStep } from './Join.tsx';

const status = (over: Partial<FactionStatus>) =>
  ({ membership: null, application: null, roster: [], ...over });
const application = (faction: 'police' | 'vipers', stage: string) =>
  ({ faction, stage }) as FactionStatus['application'];

describe('joinStep', () => {
  it('starts at applying, also for someone busy with another faction', () => {
    expect(joinStep(null, 'police')).toBe(0);
    expect(joinStep(status({}), 'police')).toBe(0);
    expect(joinStep(status({ application: application('vipers', 'training') }), 'police')).toBe(0);
  });
  it('follows the application through training and interview to membership', () => {
    expect(joinStep(status({ application: application('police', 'training') }), 'police')).toBe(1);
    expect(joinStep(status({ application: application('police', 'interview') }), 'police')).toBe(2);
    const membership = { faction: 'police', rank: 1, title: 'Cadet' } as const;
    expect(joinStep(status({ membership }), 'police')).toBe(3);
  });
});
