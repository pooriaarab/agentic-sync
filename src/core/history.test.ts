import { expect, test } from "vitest";
import * as Y from "yjs";
import { restoreState } from "./history.js";

// Ways restore can go wrong on text, listed before the change to match by item:
// 1. A snapshot from another document (no shared ids) must still restore the exact text.
// 2. A surrogate pair must never be split by an edit.
// 3. Text new since the snapshot goes, text deleted since comes back, in the right order.
const restored = (now: string, then: string): string => {
  const old = new Y.Doc();
  old.getText("body").insert(0, then);
  const live = new Y.Doc();
  live.getText("body").insert(0, now);
  restoreState(live, Y.encodeStateAsUpdate(old));
  return live.getText("body").toString();
};

test("a snapshot with no shared ids restores the exact text", () => {
  expect(restored("ab".repeat(700), "ba".repeat(700))).toBe("ba".repeat(700));
});

test("a surrogate pair is never split", () => {
  expect(restored("a\u{1F600}b\u{1F601}", "a\u{1F601}b\u{1F600}")).toBe("a\u{1F601}b\u{1F600}");
});

test("text added since goes, text deleted since comes back", () => {
  const doc = new Y.Doc();
  const body = doc.getText("body");
  body.insert(0, "keep and lose");
  const snapshot = Y.encodeStateAsUpdate(doc);
  body.delete(4, 9);
  body.insert(4, " plus new");
  body.delete(0, 1);
  body.insert(0, "K");
  restoreState(doc, snapshot);
  expect(body.toString()).toBe("keep and lose");
});
