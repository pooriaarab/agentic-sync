import { serialize } from "node:v8";
import { expect, test } from "vitest";
import * as Y from "yjs";
import { AttributionLog, LARGEST_MAX_RANGES } from "./attribution.js";

// Ways the saved log can break the 2 MiB storage value limit, written before the fix:
// 1. Many principals with long ids that take two bytes per character each hold one range.
// 2. The range count alone is no bound, because authors add their own bytes.
test("a log of many principals with long ids stays under the storage value limit", () => {
  const log = new AttributionLog(LARGEST_MAX_RANGES);
  for (let i = 0; i < LARGEST_MAX_RANGES; i++) {
    const doc = new Y.Doc();
    doc.getText("body").insert(0, "x");
    const id = `${i}`.padStart(8, "0") + "\u4e2d".repeat(248);
    log.record(Y.encodeStateAsUpdate(doc), { id, kind: "human" }, i);
  }
  expect(serialize(log.toJSON()).length).toBeLessThan(2 * 1024 * 1024);
  expect(log.toJSON().dropped).toBeGreaterThan(0);
});
