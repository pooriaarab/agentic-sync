// Away state of a peer, as the peer reports it:
//   "active"  the peer did something within the idle time, and can see the page.
//   "idle"    the peer can see the page but did nothing for the idle time.
//   "hidden"  the page is hidden (another tab, a minimized window).
// "hidden" wins over "idle". A peer that does not report a state, such as
// an older client or a headless agent, reads as "unknown".
export const AWAY_STATES = ["active", "idle", "hidden"] as const;
export type AwayState = (typeof AWAY_STATES)[number];

export function isAwayState(value: unknown): value is AwayState {
  return typeof value === "string" && (AWAY_STATES as readonly string[]).includes(value);
}

// What a reader shows for a state it got from another peer.
export function readAwayState(value: unknown): AwayState | "unknown" {
  return isAwayState(value) ? value : "unknown";
}

export interface AwayOptions {
  // Seconds without activity before the state is "idle". It may have a
  // fraction. It must be above 0.
  idleAfterSeconds: number;
  onChange?: (state: AwayState) => void;
}

// Tracks one peer's away state. It holds no timer while the page is
// hidden, and the timer does not keep a Node process alive.
export class AwayTracker {
  private current: AwayState = "active";
  private hiddenNow = false;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly idleMs: number;

  constructor(private readonly options: AwayOptions) {
    const seconds = options.idleAfterSeconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
      throw new RangeError("idleAfterSeconds must be a number above 0");
    }
    this.idleMs = seconds * 1000;
    // setTimeout holds at most 2^31 - 1 ms. A longer wait would fire at once.
    if (this.idleMs > 2 ** 31 - 1) throw new RangeError("idleAfterSeconds is too large");
    this.arm();
  }

  get state(): AwayState {
    return this.current;
  }

  // Call it on input: a key, a pointer move, an edit, a scroll.
  activity(): void {
    if (this.stopped || this.hiddenNow) return;
    this.set("active");
    this.arm();
  }

  // Call it when the page becomes hidden or visible again. A page that
  // becomes visible counts as active and starts a new idle time.
  setHidden(hidden: boolean): void {
    if (this.stopped || hidden === this.hiddenNow) return;
    this.hiddenNow = hidden;
    clearTimeout(this.timer);
    if (hidden) {
      this.set("hidden");
    } else {
      this.set("active");
      this.arm();
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.set("idle"), this.idleMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private set(state: AwayState): void {
    if (state === this.current) return;
    this.current = state;
    this.options.onChange?.(state);
  }
}
