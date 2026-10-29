import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { SyncClient } from "../src/client/index.js";
import { fromBase64 } from "../src/core/base64.js";
import { exportDocument, exportDocumentStream, type ExportRecord, type Target } from "../src/sdk.js";
import { startWorker, type Server } from "./server.js";

let server: Server;

beforeAll(async () => {
  server = await startWorker();
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

const target = (token: string): Target => ({ server: server.http, token });

describe("export of a large history", () => {
  test("the stream holds every record, in the order of the buffered export", async () => {
    const writer = await SyncClient.connect({
      url: `${server.ws}/api/v1/docs/large/ws?token=editor`,
      timeoutMs: 3000,
    });
    // 200 edits of about 1 KiB, with compaction every 5 updates, so the
    // history holds a large base state and several snapshots.
    const piece = "x".repeat(1000);
    for (let i = 0; i < 200; i++) {
      await writer.edit((doc) => doc.getText("body").insert(doc.getText("body").length, `${i}:${piece}|`));
      if ([69, 139, 199].includes(i)) await writer.snapshot(`step-${i}`);
    }
    await writer.disconnect();

    const streamed: ExportRecord[] = [];
    for await (const record of exportDocumentStream(target("editor2"), "large")) streamed.push(record);
    const buffered = await exportDocument(target("editor2"), "large");

    // The export time differs between the calls, so compare the rest. The
    // raw body is split by hand, so the check does not rely on the SDK parser.
    const raw = await (await fetch(`${server.http}/api/v1/docs/large/export?token=editor2`)).text();
    const reference = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ExportRecord);
    expect(streamed.map((record) => record.type)).toEqual(buffered.map((record) => record.type));
    expect(streamed.slice(1)).toEqual(reference.slice(1));
    expect(buffered.slice(1)).toEqual(reference.slice(1));

    const state = new Y.Doc();
    Y.applyUpdate(state, fromBase64(streamed.find((record) => record.type === "state")!.base64));
    const body = state.getText("body").toString();
    expect(body).toBe(Array.from({ length: 200 }, (_, i) => `${i}:${piece}|`).join(""));

    const snapshots = streamed.filter((record) => record.type === "snapshot");
    // The room lists snapshot names as strings, so their order is not by step.
    expect(snapshots.map((record) => record.name).sort()).toEqual(["step-139", "step-199", "step-69"]);
    expect(snapshots.every((record) => record.base64.length > 1000)).toBe(true);
    expect(JSON.stringify(streamed).length).toBeGreaterThan(500_000);
  }, 120_000);
});
