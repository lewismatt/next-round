#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// CI-only upstream standing in for `api:3000` behind Caddy. It is not a product
// route: it accepts one WebSocket upgrade on a fixture path and acknowledges
// text frames, so the Caddy proxy hop can be exercised without the real API.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);
const wsPath = "/api/__ci/ws";
const healthPath = "/api/__ci/health";
const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Requests that did not traverse Caddy lack the headers its reverse_proxy adds.
const viaCaddy = headers => Boolean(headers["x-forwarded-for"] && headers["x-forwarded-host"]);

function frame(opcode, payload) {
  if (payload.length > 125) throw new Error("fixture frames are limited to 125 bytes");
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

const server = createServer((req, res) => {
  if (req.url === healthPath && viaCaddy(req.headers)) {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  res.writeHead(404).end();
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (
    req.url !== wsPath ||
    String(req.headers.upgrade).toLowerCase() !== "websocket" ||
    typeof key !== "string" ||
    !viaCaddy(req.headers)
  ) {
    console.error(`rejected upgrade url=${req.url} upgrade=${req.headers.upgrade} viaCaddy=${viaCaddy(req.headers)}`);
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(key + guid).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  console.log(`accepted upgrade url=${req.url}`);

  let buffered = Buffer.alloc(0);
  socket.on("data", chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    // Client frames are masked; this fixture only handles payloads under 126 bytes.
    while (buffered.length >= 6) {
      const opcode = buffered[0] & 0x0f;
      const length = buffered[1] & 0x7f;
      if (length > 125 || !(buffered[1] & 0x80)) {
        socket.destroy();
        return;
      }
      if (buffered.length < 6 + length) return;
      const mask = buffered.subarray(2, 6);
      const payload = Buffer.from(buffered.subarray(6, 6 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffered = buffered.subarray(6 + length);
      if (opcode === 1) {
        console.log(`received text frame: ${payload.toString("utf8")}`);
        socket.write(frame(1, Buffer.from(`ack:${payload.toString("utf8")}`)));
      } else if (opcode === 8) {
        socket.end(frame(8, payload));
        return;
      }
    }
  });
  socket.on("error", () => {});
});

server.listen(port, "0.0.0.0", () => console.log(`fixture upstream listening on ${port}`));
