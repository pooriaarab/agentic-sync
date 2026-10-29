import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

// A WebSocket client that writes frames and never reads them. It never
// answers a close frame, so the server sees a socket that is closing and
// still open at the TCP level. A stock client would answer the close at
// once, and the window would close before the test could use it.
export class RawSocket {
  private constructor(private readonly socket: Socket) {}

  static open(url: string): Promise<RawSocket> {
    const { hostname, port, pathname, search } = new URL(url);
    return new Promise((resolve, reject) => {
      const socket = connect(Number(port), hostname, () => {
        socket.write(
          [
            `GET ${pathname}${search} HTTP/1.1`,
            `Host: ${hostname}:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });
      let head = "";
      const onData = (chunk: Buffer) => {
        head += chunk.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        socket.off("data", onData);
        socket.on("data", () => {});
        if (head.startsWith("HTTP/1.1 101")) resolve(new RawSocket(socket));
        else reject(new Error(`the upgrade was refused: ${head.split("\r\n")[0]}`));
      };
      socket.on("data", onData);
      socket.on("error", reject);
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
