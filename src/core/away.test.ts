import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AwayTracker, isAwayState, readAwayState, type AwayState } from "./away.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function track(idleAfterSeconds = 10) {
  const seen: AwayState[] = [];
  const tracker = new AwayTracker({ idleAfterSeconds, onChange: (s) => seen.push(s) });
  return { tracker, seen };
}

describe("away tracker", () => {
  test("starts active and turns idle after the idle time, once", () => {
    const { tracker, seen } = track(10);
    vi.advanceTimersByTime(9_999);
    expect(tracker.state).toBe("active");
    vi.advanceTimersByTime(1);
    expect(tracker.state).toBe("idle");
    vi.advanceTimersByTime(60_000);
    expect(seen).toEqual(["idle"]);
  });

  test("activity restarts the idle time and wakes an idle peer", () => {
    const { tracker, seen } = track(10);
    vi.advanceTimersByTime(8_000);
    tracker.activity();
    vi.advanceTimersByTime(8_000);
    expect(tracker.state).toBe("active");
    vi.advanceTimersByTime(2_000);
    expect(tracker.state).toBe("idle");
    tracker.activity();
    expect(tracker.state).toBe("active");
    expect(seen).toEqual(["idle", "active"]);
  });

  test("a hidden page is hidden, not idle, and activity does not change it", () => {
    const { tracker, seen } = track(10);
    tracker.setHidden(true);
    vi.advanceTimersByTime(60_000);
    tracker.activity();
    expect(tracker.state).toBe("hidden");
    expect(seen).toEqual(["hidden"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("an idle page that becomes hidden shows hidden", () => {
    const { tracker } = track(10);
    vi.advanceTimersByTime(10_000);
    tracker.setHidden(true);
    expect(tracker.state).toBe("hidden");
  });

  test("a page that becomes visible is active and gets a new idle time", () => {
    const { tracker } = track(10);
    tracker.setHidden(true);
    vi.advanceTimersByTime(60_000);
    tracker.setHidden(false);
    expect(tracker.state).toBe("active");
    vi.advanceTimersByTime(9_999);
    expect(tracker.state).toBe("active");
    vi.advanceTimersByTime(1);
    expect(tracker.state).toBe("idle");
  });

  test("the same visibility twice does nothing", () => {
    const { tracker, seen } = track(10);
    tracker.setHidden(false);
    tracker.setHidden(true);
    tracker.setHidden(true);
    expect(seen).toEqual(["hidden"]);
  });

  test("stop ends the timer and ignores later calls", () => {
    const { tracker, seen } = track(10);
    tracker.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    tracker.setHidden(true);
    tracker.activity();
    expect(tracker.state).toBe("active");
    expect(seen).toEqual([]);
  });

  test("takes a fraction of a second", () => {
    const { tracker } = track(0.5);
    vi.advanceTimersByTime(500);
    expect(tracker.state).toBe("idle");
  });

  test.each([0, -1, Number.NaN, Infinity, "10", null, undefined, 2 ** 31])(
    "refuses the idle time %s",
    (value) => {
      expect(() => new AwayTracker({ idleAfterSeconds: value as number })).toThrow(RangeError);
    },
  );
});

describe("away state from another peer", () => {
  test.each(["active", "idle", "hidden"])("keeps %s", (state) => {
    expect(isAwayState(state)).toBe(true);
    expect(readAwayState(state)).toBe(state);
  });

  test.each([undefined, null, "away", "ACTIVE", 1, {}, ["idle"], "__proto__"])(
    "reads %j as unknown",
    (value) => {
      expect(isAwayState(value)).toBe(false);
      expect(readAwayState(value)).toBe("unknown");
    },
  );
});
