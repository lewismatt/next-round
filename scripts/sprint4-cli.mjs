#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createSprint4Fixture } from "./sprint4-fixture.mjs";

/** JSON-lines development CLI, using the same dispatcher as repeatable game acceptance. */
export function createDevelopmentCli(fixture) {
  const env = fixture.environment();
  const clients = new Map();
  const intents = new Map();
  const subscriptions = new Map();
  function client(name) {
    const value = clients.get(name);
    assert.ok(value, `Unknown CLI client: ${name}`);
    return value;
  }
  async function execute(input) {
    assert.ok(
      input && typeof input === "object",
      "CLI input must be a JSON object",
    );
    const { op, name, matchId } = input;
    switch (op) {
      case "registered": {
        assert.ok(
          typeof name === "string" && !clients.has(name),
          "Choose an unused client name",
        );
        const value = await env.createRegisteredClient({
          username: input.username ?? name,
          displayName: input.displayName ?? name,
          role: input.role ?? "member",
          password: input.password,
        });
        clients.set(name, value);
        return {
          name,
          principalId: value.session.principalId,
          kind: value.session.kind,
        };
      }
      case "guest": {
        assert.ok(
          typeof name === "string" && !clients.has(name),
          "Choose an unused client name",
        );
        const token =
          input.token ??
          (await client(input.issuer).createGuestInvitation(matchId)).token;
        const value = await env.createGuestClient({
          displayName: input.displayName ?? name,
          token,
        });
        clients.set(name, value);
        return {
          name,
          principalId: value.session.principalId,
          kind: value.session.kind,
          matchId: value.session.guestMatchId,
        };
      }
      case "create":
        return client(name).createMatch(
          "test-counter",
          input.mode ?? "group",
          input.settings ?? { target: 10, turnSeconds: null },
          input.visibility ?? "instance",
          input.commandId,
        );
      case "join":
        return client(name).joinMatch(
          matchId,
          input.expectedRevision,
          input.linkToken,
          input.commandId,
        );
      case "start":
        return client(name).startMatch(
          matchId,
          input.expectedRevision,
          input.commandId,
        );
      case "finish":
        return client(name).finishMatch(
          matchId,
          input.expectedRevision,
          input.commandId,
        );
      case "leave":
        return client(name).leaveMatch(
          matchId,
          input.expectedRevision,
          input.commandId,
        );
      case "act": {
        const action = {
          type: input.type,
          payload: input.payload,
          expectedRevision: input.expectedRevision,
          commandId: input.commandId ?? randomUUID(),
        };
        if (input.intent) {
          assert.ok(
            !intents.has(input.intent),
            "Intent name already exists; replay it explicitly",
          );
          intents.set(input.intent, { name, matchId, action });
        }
        return client(name).act(matchId, action);
      }
      case "replay": {
        const intent = intents.get(input.intent);
        assert.ok(intent, "Unknown retained command intent");
        return client(intent.name).replayCommand(intent.matchId, intent.action);
      }
      case "post-commit-fault":
        return {
          faultId: env.faults.injectPostCommitFailure(
            matchId,
            input.count ?? 1,
          ),
          effect:
            "discard next successful committed command response for this match",
        };
      case "snapshot":
        return client(name).getSnapshot(matchId);
      case "result":
        return client(name).getResult(matchId);
      case "subscribe": {
        const key = `${name}:${matchId}`;
        if (!subscriptions.has(key))
          subscriptions.set(
            key,
            client(name).onSnapshot(matchId, () => {}),
          );
        await client(name).connectWs();
        return {
          name,
          matchId,
          connected: client(name).connectionState.wsConnected,
        };
      }
      case "disconnect":
        client(name).disconnectWs();
        return { name, connected: false };
      case "reconnect":
        await client(name).reconnectWs();
        return { name, connected: client(name).connectionState.wsConnected };
      case "restart":
        return fixture.restart(input.target ?? "all");
      case "expire-deadline":
        return fixture.expireDeadline(matchId);
      case "status":
        return {
          api: fixture.url,
          pids: fixture.pids,
          clients: [...clients].map(([label, value]) => ({
            name: label,
            principalId: value.session.principalId,
            kind: value.session.kind,
            ...value.connectionState,
          })),
        };
      default:
        throw new Error(
          "Unknown CLI op; use registered/guest/create/join/start/act/replay/post-commit-fault/finish/leave/snapshot/result/subscribe/disconnect/reconnect/restart/expire-deadline/status/quit",
        );
    }
  }
  return { env, clients, execute };
}

export async function createBrowserFixture(fixture, cli) {
  for (const name of ["s4_host", "s4_peer", "s4_outsider"])
    await cli.execute({ op: "registered", name });
  const { matchId } = await cli.execute({
    op: "create",
    name: "s4_host",
    mode: "group",
    settings: { target: 20, turnSeconds: null },
  });
  const joined = await cli.execute({
    op: "join",
    name: "s4_peer",
    matchId,
    expectedRevision: 0,
  });
  await cli.execute({
    op: "start",
    name: "s4_host",
    matchId,
    expectedRevision: joined.committedRevision,
  });
  const invitation = await cli.clients
    .get("s4_host")
    .createGuestInvitation(matchId);
  return {
    fixture:
      "Sprint 4 disposable development fixture (credentials are local-only)",
    api: fixture.url,
    pids: fixture.pids,
    accounts: [...fixture.accounts.values()].map(({ username, password }) => ({
      username,
      password,
    })),
    matchId,
    guestInvitation: `${process.env.APP_ORIGIN ?? "http://127.0.0.1:3000"}/guest#${invitation.token}`,
    browser: process.env.APP_ORIGIN ?? "http://127.0.0.1:3000",
    viteEnv: { VITE_API_PROXY_TARGET: fixture.url },
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`TEST_DATABASE_URL=postgresql://... node scripts/sprint4-cli.mjs [--scenario|--fixture]
Default: newline-delimited JSON operations on stdin; quit closes all children and drops the disposable database.
--fixture: creates real host/peer/outsider accounts, a started untimed Test Counter match, guest invitation; stays alive until SIGINT/SIGTERM.
--scenario: exercises this same dispatcher and residual F2 predicates, then cleans up.
SPRINT4_PORT=3100 APP_ORIGIN=http://127.0.0.1:3000 configures a stable browser fixture.
Examples (after reading emitted match ID):
{"op":"snapshot","name":"s4_host","matchId":"..."}
{"op":"subscribe","name":"s4_peer","matchId":"..."}
{"op":"act","name":"s4_host","matchId":"...","type":"add","payload":{"amount":1},"expectedRevision":2,"intent":"first-score"}
{"op":"replay","intent":"first-score"}
{"op":"restart","target":"all"}
{"op":"disconnect","name":"s4_peer"}
{"op":"reconnect","name":"s4_peer"}
Clock expiry is a disposable database test-service operation, never a production API route.`);
    return;
  }
  const fixture = await createSprint4Fixture({
    port: Number(process.env.SPRINT4_PORT ?? 0),
    browserOrigin: process.env.APP_ORIGIN ?? "http://127.0.0.1:3000",
  });
  let closing;
  const close = () => (closing ??= fixture.close());
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(
      signal,
      () =>
        void close()
          .then(() => process.exit(0))
          .catch((error) => {
            console.error(error);
            process.exit(1);
          }),
    );
  try {
    const cli = createDevelopmentCli(fixture);
    if (process.argv.includes("--scenario")) {
      const { runGameAcceptance } = await import("./sprint4-gameplay.mjs");
      console.log(
        JSON.stringify(await runGameAcceptance(fixture, cli), null, 2),
      );
      return;
    }
    console.log(JSON.stringify(await createBrowserFixture(fixture, cli)));
    if (process.argv.includes("--fixture")) {
      await new Promise(() => {});
    } else {
      const lines = createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const input = JSON.parse(line);
          if (input.op === "quit") break;
          console.log(
            JSON.stringify({ ok: true, result: await cli.execute(input) }),
          );
        } catch (error) {
          console.log(
            JSON.stringify({
              ok: false,
              error: {
                name: error.name,
                code: error.code,
                commandId: error.commandId,
                message: error.message,
              },
            }),
          );
        }
      }
    }
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
