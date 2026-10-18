// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTrustedProxies } from "./config.js";
import { buildServer } from "./server.js";
import type { FastifyInstance } from "fastify";

let root: string;
const servers: FastifyInstance[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "next-round-security-"));
  vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("hex"));
  vi.stubEnv("SETUP_TOKEN", randomBytes(32).toString("hex"));
  vi.stubEnv("TRUST_PROXY", "");
  vi.stubEnv("SOURCE_URL", "");
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function server(trustProxy?: false | string | string[]) {
  const app = await buildServer({ logger: false, staticRoot: root, trustProxy });
  servers.push(app);
  app.get("/test/ip", async (request) => ({ ip: request.ip }));
  return app;
}

describe("GH-1 H-1: proxy trust", () => {
  it("ignores forged forwarded headers without configured trust", async () => {
    const app = await server();
    const response = await app.inject({
      url: "/test/ip", remoteAddress: "203.0.113.10",
      headers: { "x-forwarded-for": "198.51.100.20" },
    });
    expect(response.json()).toEqual({ ip: "203.0.113.10" });
  });

  it("accepts forwarding only from a listed proxy, stopping at an untrusted hop", async () => {
    const app = await server(["10.0.0.2/32", "::1/128"]);
    for (const [remoteAddress, forwarded, ip] of [
      ["10.0.0.2", "198.51.100.20", "198.51.100.20"],
      ["203.0.113.10", "198.51.100.20", "203.0.113.10"],
      ["10.0.0.2", "198.51.100.20, 203.0.113.10", "203.0.113.10"],
      ["::1", "198.51.100.20", "198.51.100.20"],
    ]) {
      expect((await app.inject({ url: "/test/ip", remoteAddress,
        headers: { "x-forwarded-for": forwarded } })).json()).toEqual({ ip });
    }
  });

  it("reads an explicit environment allowlist and permits an explicit false override", async () => {
    vi.stubEnv("TRUST_PROXY", "10.0.0.2, 2001:db8::/32");
    expect(parseTrustedProxies()).toEqual(["10.0.0.2", "2001:db8::/32"]);
    expect(parseTrustedProxies(false)).toBe(false);
    expect(parseTrustedProxies("false")).toBe(false);
  });

  it.each(["true", "*", "1", "0.0.0.0/0", "::/0", "10.0.0.1/33", "::1/129", "10.0.0.2,", "10.0.0.2/24/1"])(
    "rejects unsafe or malformed trust configuration: %s", (value) => {
      expect(() => parseTrustedProxies(value)).toThrow("TRUST_PROXY");
    }
  );

  it("cannot bypass the IP limit by changing forwarded-for", async () => {
    const app = await buildServer({ logger: false, staticRoot: root, rateLimitMax: 1 });
    servers.push(app);
    await app.ready();
    const request = (ip: string) => app.inject({ url: "/version", remoteAddress: "203.0.113.10",
      headers: { "x-forwarded-for": ip } });
    expect((await request("198.51.100.1")).statusCode).toBe(200);
    expect((await request("198.51.100.2")).statusCode).toBe(429);
  });
});

describe("GH-1 H-3: required secrets", () => {
  it.each(["SESSION_SECRET", "SETUP_TOKEN"])("rejects missing or short %s before boot", async (name) => {
    for (const value of [undefined, "", "short", " ".repeat(64)]) {
      vi.stubEnv(name, value);
      await expect(buildServer({ logger: false, staticRoot: root })).rejects.toThrow(name);
    }
  });

  it("boots with locally supplied secrets and reports the correct source URL (L-1)", async () => {
    const response = await (await server()).inject("/version");
    expect(response.statusCode).toBe(200);
    expect(response.json().sourceUrl).toBe("https://github.com/lewismatt/next-round");
    expect(response.body).not.toContain(process.env.SESSION_SECRET);
    expect(response.body).not.toContain(process.env.SETUP_TOKEN);
  });
});

it("GH-1 L-2: closes an oversized WebSocket message with 1009", async () => {
  const app = await server();
  app.get("/test/live", { websocket: true }, (socket) => {
    socket.on("error", () => {});
    socket.on("message", () => socket.send("accepted"));
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const socket = new WebSocket(address.replace("http:", "ws:") + "/test/live");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const accepted = new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
    socket.send(Buffer.alloc(16 * 1024));
    await accepted;
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
    socket.send(Buffer.alloc(16 * 1024 + 1));
    expect(await closed).toBe(1009);
  } finally {
    socket.close();
  }
});
