import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { SyncClient } from "../src/client/index.js";
import { fromBase64 } from "../src/core/base64.js";
import { updateMessage } from "../src/core/protocol.js";
import { deleteDocument, exportDocument, type Target } from "../src/sdk.js";
import { RawSocket } from "./raw-socket.js";
import { startWorker, until, type Server } from "./server.js";

let server: Server;

beforeAll(async () => {
  server = await startWorker();
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

const target = (token: string): Target => ({ server: server.http, token });
// The text of the export's state, as the room holds it now.
async function bodyText(): Promise<string> {
  const lines = await exportDocument(target("editor2"), "closing");
  const state = new Y.Doc();
  Y.applyUpdate(state, fromBase64(lines.find((line) => line.type === "state")!.base64));
  return state.getText("body").toString();
}

describe("a socket that is closing", () => {
  test("cannot write after a delete", async () => {
    const writer = await SyncClient.connect({
      url: `${server.ws}/api/v1/docs/closing/ws?token=editor`,
      timeoutMs: 3000,
    });
    await writer.edit((doc) => doc.getText("body").insert(0, "before"));
    await writer.disconnect();

    // Holds the socket open after the server starts closing it.
    const late = await RawSocket.open(`${server.ws}/api/v1/docs/closing/ws?token=editor`);
    try {
      const result = await deleteDocument(target("editor2"), "closing");
      expect(result.sockets).toBe(1);

      // The socket is closing, so this update must not land.
      const lateDoc = new Y.Doc();
      lateDoc.getText("body").insert(0, "late");
      late.send(updateMessage(Y.encodeStateAsUpdate(lateDoc)));

      // The late frame was sent first. Waiting for this later write to be
      // stored gives the late frame time to arrive. Order across two
      // connections is not guaranteed, so this bounds the wait rather than
      // proving the frame was handled.
      const marker = await SyncClient.connect({
        url: `${server.ws}/api/v1/docs/closing/ws?token=editor`,
        timeoutMs: 3000,
      });
      await marker.edit((doc) => doc.getText("body").insert(0, "marker"));
      await marker.disconnect();
      await until(async () => (await bodyText()).includes("marker"), "the marker to be stored");
      expect(await bodyText()).toBe("marker");
    } finally {
      late.destroy();
    }
  }, 60_000);
});
