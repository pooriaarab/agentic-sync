import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

// The GUID that RFC 6455 adds to the key before it hashes it.
const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HANDSHAKE_MS = 5000;

// A WebSocket client that writes frames and never reads them. It never
// answers a close frame, so the server sees a socket that is closing and
// still open at the TCP level. A stock client would answer the close at
// once, and the window would close before the test could use it.
// The accept key from the response headers. Header names are case-blind,
// and a space after the colon is optional.
function acceptOf(head: string): string | undefined {
  const line = head.split("\r\n").find((text) => /^sec-websocket-accept:/i.test(text));
  return line?.slice(line.indexOf(":") + 1).trim();
}

export class RawSocket {
  private constructor(private readonly socket: Socket) {}

  static open(url: string): Promise<RawSocket> {
    const { hostname, port, pathname, search } = new URL(url);
    const key = randomBytes(16).toString("base64");
    const accept = createHash("sha1").update(key + ACCEPT_GUID).digest("base64");
    return new Promise((resolve, reject) => {
      const socket = connect(Number(port), hostname, () => {
        socket.write(
          [
            `GET ${pathname}${search} HTTP/1.1`,
            `Host: ${hostname}:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("the upgrade timed out")), HANDSHAKE_MS);
      let head = "";
      const onData = (chunk: Buffer) => {
        head += chunk.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        clearTimeout(timer);
        socket.off("data", onData);
        socket.on("data", () => {});
        if (!head.startsWith("HTTP/1.1 101")) {
          fail(new Error(`the upgrade was refused: ${head.split("\r\n")[0]}`));
        } else if (acceptOf(head) !== accept) {
          fail(new Error("the upgrade has a wrong accept key"));
        } else {
          resolve(new RawSocket(socket));
        }
      };
      socket.on("data", onData);
      socket.on("error", (error) => fail(error));
    });
  }

  // Sends one binary frame, masked as a client must.
  send(payload: Uint8Array): void {
    const mask = randomBytes(4);
    const length = payload.length;
    const header =
      length < 126
        ? Buffer.from([0x82, 0x80 | length])
        : length < 65536
          ? Buffer.from([0x82, 0x80 | 126, length >> 8, length & 0xff])
          : (() => {
              throw new Error("frame too large for this client");
            })();
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, body]));
  }

  destroy(): void {
    this.socket.destroy();
  }
}
