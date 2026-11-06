/**
 * Jobs as the client sees them (Phase 6; the server's framework is apps/world jobs/). The
 * server sends the player's job as a JobView; the client only asks to use city points.
 */

export type JobId = 'courier' | 'mining' | 'taxi' | 'collect' | 'haul';

/** Where each job is offered (a city point kind), and what its prompt says. */
export const JOB_OFFERS: Record<string, { job: JobId; label: string }> = {
  depot: { job: 'courier', label: 'Start a courier shift' },
  quarry_office: { job: 'mining', label: 'Sign on for mining' },
  taxi_depot: { job: 'taxi', label: 'Start a taxi shift' },
  hideout: { job: 'collect', label: 'Run collections' },
  dock: { job: 'haul', label: 'Load the Market order' },
};

/** Something the player can do now: use a point (the client shows the prompt). */
export interface JobAction {
  point: number;
  label: string;
  icon: 'job' | 'door' | 'talk';
  /** Hold to use (ms). */
  holdMs?: number;
  /** A timed press per use (the mining swing). */
  timing?: boolean;
}

/** The job as the HUD shows it (sent as JSON in the `job` message). */
export interface JobView {
  job: JobId;
  title: string;
  /** What to do now, in a few words. */
  step: string;
  /** Where to go next (the waypoint), if anywhere. */
  objective: { x: number; z: number; label: string } | null;
  actions: JobAction[];
  /** e.g. packages in the van, ore in the bag. */
  cargo?: { label: string; count: number; max?: number };
  progress?: { done: number; total: number; label: string };
  /** Server time (ms) the shift ends by itself. */
  endsAt?: number;
  /** Earned on this shift so far. */
  earned: { cents: number; xp: number };
}
