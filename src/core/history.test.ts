import { expect, test } from "vitest";
import * as Y from "yjs";
import { restoreState } from "./history.js";

// Ways restore can go wrong on text, listed before the fix to the diff:
// 1. A text that needs more than the diff limit of changes must still end up equal to the snapshot.
// 2. Two characters of a surrogate pair must never be split by an edit.
const restored = (now: string, then: string): string => {
  const old = new Y.Doc();
  old.getText("body").insert(0, then);
  const live = new Y.Doc();
  live.getText("body").insert(0, now);
  restoreState(live, Y.encodeStateAsUpdate(old));
  return live.getText("body").toString();
};

test("a text that differs in more places than the diff looks for still restores exactly", () => {
  const [now, then] = ["ab".repeat(700), "ba".repeat(700)];
  expect(restored(now, then)).toBe(then);
});

test("a surrogate pair is never split", () => {
  expect(restored("a\u{1F600}b\u{1F601}", "a\u{1F601}b\u{1F600}")).toBe("a\u{1F601}b\u{1F600}");
  expect(restored("\u{1F600}x", "\u{1F601}x")).toBe("\u{1F601}x");
});
