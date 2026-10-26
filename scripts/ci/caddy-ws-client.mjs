#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/* global WebSocket */
// Completes one WebSocket upgrade through Caddy's published port and exchanges
// one frame. Exits non-zero on any failure so the CI job fails.
import assert from "node:assert/strict";
const url = process.argv[2];
if (!url) {
  console.error("usage: caddy-ws-client.mjs <ws-url>");
  process.exit(2);
}
const health = new URL("/api/__ci/health", url);
health.protocol = health.protocol === "wss:" ? "https:" : "http:";
const response = await fetch(health);
assert.equal(response.status, 200);
const csp = response.headers.get("content-security-policy");
assert.ok(csp?.includes(`connect-src 'self' ${new URL(url).origin}`));
assert.ok(csp.includes("script-src-attr 'none'"));
assert.equal(csp.includes(","), false, "CSP must not be duplicated");
console.log("Enforced CSP names the fixture's exact WebSocket origin.");
const message = "m9-caddy-frame";
const expected = `ack:${message}`;

let exchanged = false;
const timer = setTimeout(() => fail("timed out waiting for upgrade and frame exchange"), 15_000);
const socket = new WebSocket(url);

function fail(reason) {
  console.error(`WebSocket check failed: ${reason}`);
  process.exit(1);
}

socket.addEventListener("open", () => {
  console.log(`upgrade completed through Caddy: ${url}`);
  socket.send(message);
});
socket.addEventListener("message", event => {
  if (event.data !== expected) fail(`expected frame ${JSON.stringify(expected)}, got ${JSON.stringify(event.data)}`);
  console.log(`frame exchanged: sent ${JSON.stringify(message)}, received ${JSON.stringify(event.data)}`);
  exchanged = true;
  clearTimeout(timer);
  socket.close(1000);
});
socket.addEventListener("error", () => fail("upgrade or connection error"));
socket.addEventListener("close", event => {
  if (!exchanged) fail(`closed before frame exchange completed (code ${event.code})`);
  console.log("WebSocket upgrade through pinned Caddy verified.");
  process.exit(0);
});
