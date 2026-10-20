// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("TRUST_PROXY", "");
  vi.stubEnv("SOURCE_URL", "");
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function server(trustProxy?: false | string | string[]) {
  const app = await buildServer({
    logger: false,
    staticRoot: root,
    trustProxy,
    enableLiveListener: false,
    checkDb: async () => true,
    checkRegistry: async () => true,
  });
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
    const app = await buildServer({
      logger: false,
      staticRoot: root,
      rateLimitMax: 1,
      enableLiveListener: false,
      checkDb: async () => true,
      checkRegistry: async () => true,
    });
    servers.push(app);
    await app.ready();
    const request = (ip: string) => app.inject({ url: "/version", remoteAddress: "203.0.113.10",
      headers: { "x-forwarded-for": ip } });
    expect((await request("198.51.100.1")).statusCode).toBe(200);
    expect((await request("198.51.100.2")).statusCode).toBe(429);
  });
});

describe("GH-1 H-3: required secrets", () => {
  it("rejects a missing or short SESSION_SECRET before boot", async () => {
    for (const value of [undefined, "", "short", " ".repeat(64)]) {
      vi.stubEnv("SESSION_SECRET", value);
      await expect(buildServer({ logger: false, staticRoot: root })).rejects.toThrow("SESSION_SECRET");
    }
  });

  it.each(["short", " ".repeat(64)])("rejects a malformed SETUP_TOKEN before boot", async (value) => {
    vi.stubEnv("SETUP_TOKEN", value);
    await expect(buildServer({ logger: false, staticRoot: root })).rejects.toThrow("SETUP_TOKEN");
  });

  it.each([undefined, "", "https://example.com/path", "http://example.com", "https://user@example.com"])(
    "rejects a missing or unsafe APP_ORIGIN: %s",
    async (value) => {
      vi.stubEnv("APP_ORIGIN", value);
      await expect(buildServer({ logger: false, staticRoot: root })).rejects.toThrow("APP_ORIGIN");
    },
  );

  it("boots with locally supplied secrets and reports the correct source URL (L-1)", async () => {
    const response = await (await server()).inject("/version");
    expect(response.statusCode).toBe(200);
    expect(response.json().sourceUrl).toBe("https://github.com/lewismatt/next-round");
    expect(response.body).not.toContain(process.env.SESSION_SECRET);
    expect(response.body).not.toContain(process.env.SETUP_TOKEN);
  });
});

it("serves browser entry paths without turning unknown API or asset requests into HTML", async () => {
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>Local shell fixture</title>");
  await writeFile(path.join(root, "client.js"), "export const fixture = true;");
  const app = await server();
  const entry = await app.inject({ url: "/matches/fixture", headers: { accept: "text/html" } });
  expect(entry.statusCode).toBe(200);
  expect(entry.headers["content-type"]).toContain("text/html");
  expect(entry.body).toContain("Local shell fixture");
  const script = await app.inject("/client.js");
  expect(script.body).toBe("export const fixture = true;");
  for (const url of ["/api/v1/absent", "/games/absent/client.js", "/assets/absent.js"]) {
    const absent = await app.inject({ url, headers: { accept: "text/html" } });
    expect(absent.statusCode).toBe(404);
    expect(absent.body).not.toContain("Local shell fixture");
  }
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

describe("HTTP parser error privacy", () => {
  it.each([
    { payload: "", status: 400 },
    { payload: '{"password":"private-parser-input",', status: 400 },
    { payload: JSON.stringify({ guess: "x".repeat(1024 * 1024) }), status: 413 },
  ])("returns a safe client error for rejected JSON ($status)", async ({ payload, status }) => {
    const app = await server();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(response.json().error.requestId).toEqual(expect.any(String));
    expect(response.body).not.toContain("private-parser-input");
    expect(response.body.length).toBeLessThan(1024);
  });
});

it("keeps unhandled driver and reducer errors out of logs and responses", async () => {
  const app = await server();
  const privateValue = "private-reducer-state-and-guess";
  const logged = vi.fn();
  app.get("/test/private-error", async (request) => {
    request.log.error = logged;
    throw Object.assign(new Error(privateValue, { cause: new Error(privateValue) }), {
      detail: `Failing row contains ${privateValue}`,
      query: privateValue,
    });
  });

  const response = await app.inject("/test/private-error");
  expect(response.statusCode).toBe(500);
  expect(response.json().error).toMatchObject({
    code: "INTERNAL_ERROR",
    requestId: expect.any(String),
  });
  expect(response.body).not.toContain(privateValue);
  expect(logged).toHaveBeenCalledExactlyOnceWith(
    { code: "INTERNAL_ERROR" },
    "Unhandled API request error",
  );
});
