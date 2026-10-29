import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { exportDocument, exportDocumentStream, type ExportRecord } from "./sdk.js";

// A fake room that answers the export route with whatever the test writes.
// The SDK reads only the body, so no Worker is needed here.
let server: Server;
let base: string;
let respond: (res: ServerResponse) => void | Promise<void> = () => {};
const pause = () => new Promise((resolve) => setTimeout(resolve, 1));

// Runs when the client closes a request. A test sets it before it waits.
let onClose = () => {};

beforeEach(async () => {
  server = createServer((_req, res) => {
    res.on("close", () => onClose());
    void Promise.resolve(respond(res)).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  respond = () => {};
  onClose = () => {};
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Read at call time, because the port is known only after listen.
const target = () => ({ server: base, token: "owner" });
const line = (record: ExportRecord) => `${JSON.stringify(record)}\n`;

async function collectAll(gen: AsyncIterable<ExportRecord>): Promise<ExportRecord[]> {
  const out: ExportRecord[] = [];
  for await (const record of gen) out.push(record);
  return out;
}

describe("exportDocumentStream", () => {
  test("a record split across chunks is read whole", async () => {
    const records = [{ type: "meta", n: 1 }, { type: "state", base64: "AAAA".repeat(500) }];
    const body = records.map(line).join("");
    respond = async (res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      // Chunks of 7 bytes, a pause between each, so the client reads them
      // apart and every record is cut in several places.
      for (let i = 0; i < body.length; i += 7) {
        res.write(body.slice(i, i + 7));
        await pause();
      }
      res.end();
    };
    expect(await collectAll(exportDocumentStream(target(), "doc"))).toEqual(records);
  });

  test("a multi-byte character split across chunks decodes", async () => {
    const records = [{ type: "roots", roots: { body: "café 🙂 naïve" } }];
    const bytes = Buffer.from(records.map(line).join(""), "utf8");
    respond = async (res) => {
      res.writeHead(200);
      // One byte at a time, so the emoji and the accented letters are cut.
      for (const byte of bytes) {
        res.write(Buffer.from([byte]));
        await pause();
      }
      res.end();
    };
    expect(await collectAll(exportDocumentStream(target(), "doc"))).toEqual(records);
  });

  test("the first record arrives before the body ends", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    respond = (res) => {
      res.writeHead(200);
      res.write(line({ type: "meta", format: "agentic-realtime-export" }));
      void held.then(() => {
        res.end(line({ type: "authors", authors: [] }));
      });
    };
    const records = exportDocumentStream(target(), "doc");
    const first = records.next();
    const timeout = new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 3000));
    // A reader that waited for the whole body would wait here until the
    // timeout, because the body does not end until the release below.
    expect(await Promise.race([first, timeout])).toMatchObject({ value: { type: "meta" } });
    release();
    expect((await records.next()).value).toEqual({ type: "authors", authors: [] });
    expect((await records.next()).done).toBe(true);
  });

  test("a last line with no newline is read, and blank lines are skipped", async () => {
    respond = (res) => {
      res.writeHead(200);
      res.write(`\n${JSON.stringify({ type: "meta" })}\n\n`);
      res.end(JSON.stringify({ type: "authors", authors: [] }));
    };
    expect(await collectAll(exportDocumentStream(target(), "doc"))).toEqual([
      { type: "meta" },
      { type: "authors", authors: [] },
    ]);
  });

  test("a refused request throws before any record", async () => {
    respond = (res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "OWNER_ONLY" } }));
    };
    await expect(collectAll(exportDocumentStream(target(), "doc"))).rejects.toThrow("OWNER_ONLY");
  });

  test("a malformed line throws", async () => {
    respond = (res) => {
      res.writeHead(200);
      res.end(`${JSON.stringify({ type: "meta" })}\n{"type":\n`);
    };
    await expect(collectAll(exportDocumentStream(target(), "doc"))).rejects.toThrow(SyntaxError);
  });

  test("stopping early closes the connection", async () => {
    respond = (res) => {
      res.writeHead(200);
      res.write(line({ type: "meta" }));
      // The body stays open until the client goes away.
    };
    const closed = new Promise<void>((resolve) => (onClose = resolve));
    for await (const record of exportDocumentStream(target(), "doc")) {
      expect(record).toEqual({ type: "meta" });
      break;
    }
    await closed;
  });
});

describe("exportDocument", () => {
  test("returns every record, as the stream does", async () => {
    const records = [{ type: "meta" }, { type: "caps", caps: [] }];
    respond = (res) => {
      res.writeHead(200);
      res.end(records.map(line).join(""));
    };
    expect(await exportDocument(target(), "doc")).toEqual(records);
  });
});
