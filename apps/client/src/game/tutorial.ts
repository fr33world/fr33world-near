/**
 * The tutorial (PRD §5): Luz, the city's guide, teaches the game through play. Each step says
 * what to do and watches for the player doing it (walking, looking round, opening the map,
 * using the kiosk, a first delivery, the phone, a car, saying hi), with a waypoint where a
 * place is involved. Progress is saved as it goes (the API keeps it with the character), so a
 * new session carries on from the same step; it can be skipped at any time, and finishing it
 * pays once.
 */
import { RENTAL, TUTORIAL_STEPS, type TutorialStep } from '@fr33world/shared';
import type { Game } from './Game.ts';

type Step = (typeof TUTORIAL_STEPS)[number];

interface Lesson {
  say: (touch: boolean) => string;
  /** A button instead of a check (the welcome). */
  button?: string;
  /** This step alone may be skipped (it takes a while). */
  skippable?: boolean;
  /** Where to go, if anywhere. */
  target?: (game: Game) => { x: number; z: number; label: string } | null;
  /** Done yet? `since` is what the counters and position were when the step began. */
  done?: (game: Game, since: Since) => boolean;
}

interface Since {
  x: number;
  z: number;
  /** Camera yaw then, and how far it has turned since (rad). */
  yaw: number;
  turned: number;
  events: Record<string, number>;
  rewards: number;
}

const point = (game: Game, kind: string) => game.layout.points.find((p) => p.kind === kind);
const more = (game: Game, since: Since, event: string) =>
  (game.events[event] ?? 0) > (since.events[event] ?? 0);

const LESSONS: Record<Step, Lesson> = {
  welcome: {
    say: () =>
      "Hi, I'm Luz, your guide to Los Soles! The whole city is open: work, drive, meet people, " +
      'make a name for yourself. Let me show you around. It only takes a few minutes.',
    button: "Let's go",
  },
  move: {
    say: (touch) =>
      touch
        ? 'Put your left thumb anywhere on the left of the screen and drag to walk. Push further to run.'
        : 'Walk with W A S D. Hold Shift to walk slowly, Space to jump.',
    done: (game, since) => {
      const at = game.whereabouts();
      return !!at && Math.hypot(at.x - since.x, at.z - since.z) > 8;
    },
  },
  look: {
    say: (touch) =>
      touch
        ? 'Drag on the right side of the screen to look around.'
        : 'Move the mouse to look around (click the game first to grab the mouse).',
    done: (_game, since) => since.turned > 1.6,
  },
  map: {
    say: () => 'Tap the minimap in the top corner to open the map of the whole island.',
    done: (game, since) => more(game, since, 'map'),
  },
  kiosk: {
    say: (touch) =>
      `On the map you can tap any place to get a route. For now I've marked the city guide ` +
      `kiosk: follow the green arrows and ${touch ? 'tap the prompt' : 'press E'} to use it.`,
    target: (game) => {
      const k = point(game, 'info');
      return k ? { x: k.x, z: k.z, label: 'City guide kiosk' } : null;
    },
    done: (game, since) => more(game, since, 'guide'),
  },
  job: {
    say: () =>
      'Time to earn! The Courier Depot always needs couriers. Head to the lockers, start a shift, ' +
      'collect the packages and deliver the first one. Pay goes straight to your bank.',
    skippable: true,
    target: (game) => {
      if (game.job) return null;
      const d = point(game, 'depot');
      return d ? { x: d.x, z: d.z, label: 'Courier Depot lockers' } : null;
    },
    done: (game, since) => game.rewards.length > since.rewards,
  },
  phone: {
    say: (touch) =>
      `Nicely done! Every job pays money and XP, and XP raises your level. ` +
      `Open your phone (${touch ? 'the phone button' : 'P'}) to see your bank and progress.`,
    done: (game, since) => more(game, since, 'phone'),
  },
  car: {
    say: (touch) =>
      `You've a free rental car from the Car Dealership for your first ${RENTAL.days} days: fetch it ` +
      `from the blue P at any car park, and earn enough to buy your own before it's due back. ` +
      `The Garage app on your phone gives directions: walk up to your car and ` +
      `${touch ? 'tap Enter car' : 'press E'}.`,
    done: (game) => game.hud.driving,
  },
  social: {
    say: (touch) =>
      `Los Soles is better with people. Say hi in chat (${touch ? 'the chat button' : 'T'}) ` +
      `or wave (${touch ? 'the smiley' : 'G'}). Hold the mic to talk to anyone nearby.`,
    done: (game, since) => more(game, since, 'chat') || more(game, since, 'emote'),
  },
  done: {
    say: () =>
      "That's everything! Here's a little something to start you off. If you need help, " +
      'type /help in chat. See you around Los Soles!',
    button: 'Thanks, Luz',
  },
};

export class Tutorial {
  step: Step;
  private readonly game: Game;
  private since: Since;
  /** The tutorial is finished and its last words said: the HUD hides it. */
  over = false;

  constructor(game: Game, from: TutorialStep) {
    this.game = game;
    this.step = from === 'skipped' ? 'done' : from;
    this.since = this.snapshot();
    this.guide();
  }

  get lesson(): Lesson {
    return LESSONS[this.step];
  }

  get number(): number {
    return TUTORIAL_STEPS.indexOf(this.step) + 1;
  }

  private snapshot(): Since {
    const at = this.game.whereabouts();
    return {
      x: at?.x ?? 0,
      z: at?.z ?? 0,
      yaw: at?.yaw ?? 0,
      turned: 0,
      events: { ...this.game.events },
      rewards: this.game.rewards.length,
    };
  }

  /** Once a frame. */
  update(): void {
    if (this.over) return;
    const at = this.game.whereabouts();
    if (at) {
      let d = at.yaw - this.since.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.since.turned += Math.abs(d);
      this.since.yaw = at.yaw;
      if (this.since.x === 0 && this.since.z === 0) {
        this.since.x = at.x;
        this.since.z = at.z;
      }
    }
    if (this.lesson.done?.(this.game, this.since)) this.next();
    else if (this.lesson.target) this.guide();
  }

  /** The step's waypoint (a job's own waypoint wins while there is one). */
  private guide() {
    const t = this.lesson.target?.(this.game) ?? null;
    if (t) {
      if (this.game.waypoints.target?.by !== 'job')
        this.game.waypoints.set({ ...t, by: 'tutorial' });
    } else this.game.waypoints.clear('tutorial');
  }

  /** On to the next step (the button, a done check, or skipping one step). */
  next(): void {
    if (this.step === 'done') {
      this.over = true;
      return;
    }
    const i = TUTORIAL_STEPS.indexOf(this.step);
    this.step = TUTORIAL_STEPS[i + 1] ?? 'done';
    this.since = this.snapshot();
    this.guide();
    this.game.saveTutorial(this.step);
  }

  /** Ends it without the reward. */
  skip(): void {
    this.over = true;
    this.game.waypoints.clear('tutorial');
    this.game.saveTutorial('skipped');
  }
}
