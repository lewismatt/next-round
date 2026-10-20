// SPDX-License-Identifier: Apache-2.0
import type { CommandReceipt, Json } from "@next-round/contracts";
import type { MatchSnapshot } from "@next-round/game-client";
import { HttpSimulatedClient } from "./client.js";
import { authenticateGuest, authenticateRegistered } from "./sessions.js";
export { HttpSimulatedClient, HarnessHttpError, HarnessCommandError } from "./client.js";
export type { HttpClientOptions } from "./client.js";


// ============================================================================
// 1. Test-Service Clock Control Interface (Master Spec §10 F2)
// ============================================================================

export interface ClockControl {
  /** The same clock used by test-service-controlled deadline persistence. */
  now(): string;
  /** Advance the test service's clock by milliseconds. */
  advance(ms: number): void;
  /** Set the test service's clock explicitly. */
  set(time: string | Date | number): void;
  /** Reset the test service's clock to its default start time. */
  reset(): void;
  /** Check whether the test service clock is paused. */
  isPaused(): boolean;
  /** Pause the test service clock. */
  pause(): void;
  /** Resume the test service clock. */
  resume(): void;
}



// ============================================================================
// 2. Fault Injection Interfaces and Registry (Master Spec §10 F2, H5, F1-09)
// ============================================================================

export type FaultType =
  | "post_commit_failure"
  | "suppress_notify_wakeup"
  | "listener_disconnect"
  | "network_delay";

export interface FaultRule {
  id: string;
  type: FaultType;
  matchId?: string;
  channel?: string;
  apiProcessId?: string;
  remainingCount?: number;
  delayMs?: number;
  active: boolean;
}

export interface FaultInjector {
  injectPostCommitFailure(matchId: string, count?: number): string;
  suppressNotifyWakeup(channel: string, count?: number): string;
  simulateListenerDisconnect(apiProcessId?: string): void;
  delayRoute(route: string, delayMs: number): string;
  clearFault(id: string): boolean;
  clearAllFaults(): void;
  getActiveFaults(): readonly FaultRule[];
  shouldFault(type: FaultType, context?: Record<string, unknown>): boolean;
  consume(type: FaultType, context?: Record<string, unknown>): FaultRule | undefined;
}

export interface ServerFaultControls {
  /** Install a suppression rule in the actual test server; return its cleanup. */
  suppressNotifyWakeup(channel: string, count: number): () => void;
  disconnectListener(apiProcessId: string): void;
}

export class HarnessFaultInjector implements FaultInjector {
  private readonly rules = new Map<string, FaultRule>();
  private readonly cleanups = new Map<string, () => void>();

  constructor(private readonly serverControls?: ServerFaultControls) {}

  injectPostCommitFailure(matchId: string, count: number = 1): string {
    const id = `fault_post_commit_${crypto.randomUUID()}`;
    this.rules.set(id, {
      id,
      type: "post_commit_failure",
      matchId,
      remainingCount: count,
      active: true,
    });
    return id;
  }

  suppressNotifyWakeup(channel: string, count: number = 1): string {
    if (!this.serverControls) {
      throw new Error("Notify faults require actual test-server fault controls.");
    }
    const cleanup = this.serverControls.suppressNotifyWakeup(channel, count);
    const id = `fault_notify_${crypto.randomUUID()}`;
    this.rules.set(id, {
      id,
      type: "suppress_notify_wakeup",
      channel,
      remainingCount: count,
      active: true,
    });
    this.cleanups.set(id, cleanup);
    return id;
  }

  simulateListenerDisconnect(apiProcessId: string = "default"): void {
    if (!this.serverControls) {
      throw new Error("Listener faults require actual test-server fault controls.");
    }
    this.serverControls.disconnectListener(apiProcessId);
  }

  delayRoute(route: string, delayMs: number): string {
    const id = `fault_delay_${crypto.randomUUID()}`;
    this.rules.set(id, {
      id,
      type: "network_delay",
      channel: route,
      delayMs,
      active: true,
    });
    return id;
  }

  clearFault(id: string): boolean {
    this.cleanups.get(id)?.();
    this.cleanups.delete(id);
    return this.rules.delete(id);
  }

  clearAllFaults(): void {
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
    this.rules.clear();
  }

  getActiveFaults(): readonly FaultRule[] {
    return Array.from(this.rules.values()).filter((r) => r.active);
  }

  shouldFault(type: FaultType, context?: Record<string, unknown>): boolean {
    return this.consume(type, context) !== undefined;
  }

  consume(type: FaultType, context?: Record<string, unknown>): FaultRule | undefined {
    for (const [id, rule] of this.rules) {
      if (!rule.active || rule.type !== type) continue;
      if (rule.matchId !== undefined && rule.matchId !== context?.matchId) continue;
      if (rule.channel !== undefined && rule.channel !== context?.channel) continue;
      if (rule.apiProcessId !== undefined && rule.apiProcessId !== context?.apiProcessId) continue;
      if (rule.remainingCount !== undefined) {
        rule.remainingCount -= 1;
        if (rule.remainingCount <= 0) {
          rule.active = false;
          this.rules.delete(id);
        }
      }
      return rule;
    }
    return undefined;
  }
}
export interface SimulatedSession {
  principalId: string;
  kind: "registered" | "guest";
  displayName: string;
  username: string | null;
  guestMatchId: string | null;
  /** Complete session Cookie header, supplied by the real authentication response. */
  cookie: string;
  csrfToken: string;
}

export interface ClientConnectionState {
  wsConnected: boolean;
  activeMatchId: string | null;
}

export interface SimulatedClient {
  readonly session: SimulatedSession;
  readonly connectionState: ClientConnectionState;
  readonly receivedSnapshots: readonly MatchSnapshot[];
  readonly receivedReceipts: readonly CommandReceipt[];
  readonly receivedErrors: readonly Error[];

  connectWs(): Promise<void>;
  disconnectWs(): void;
  reconnectWs(): Promise<void>;

  createMatch(
    moduleId: string,
    mode: string,
    settings?: Json,
    visibility?: "invite" | "instance",
    commandId?: string
  ): Promise<{ matchId: string; commandId: string }>;

  joinMatch(matchId: string, expectedRevision: number, linkToken?: string, commandId?: string): Promise<CommandReceipt>;
  startMatch(matchId: string, expectedRevision: number, commandId?: string): Promise<CommandReceipt>;
  finishMatch(matchId: string, expectedRevision: number, commandId?: string): Promise<CommandReceipt>;
  act(
    matchId: string,
    action: {
      type: string;
      payload: Json;
      commandId?: string;
      expectedRevision: number;
    }
  ): Promise<CommandReceipt>;

  replayCommand(
    matchId: string,
    action: { type: string; payload: Json; commandId: string; expectedRevision: number }
  ): Promise<CommandReceipt>;

  leaveMatch(matchId: string, expectedRevision: number, commandId?: string): Promise<CommandReceipt>;
  getSnapshot(matchId: string): Promise<MatchSnapshot>;
  getResult(matchId: string): Promise<Json>;
  createGuestInvitation(matchId: string, commandId?: string): Promise<{ token: string; commandId: string }>;
  onSnapshot(matchId: string, listener: (snapshot: MatchSnapshot) => void): () => void;
}


// ============================================================================
// 4. Harness Environment (Master Spec §10 F2)
// ============================================================================

export interface RegisteredClientInput {
  username: string;
  displayName: string;
  role?: "admin" | "member";
  password?: string;
}

export interface HarnessConfig {
  baseUrl: string;
  /** Public browser origin when the isolated API is behind a dev proxy. */
  origin?: string;

  /** Optional test-service clock. Production APIs use PostgreSQL time directly. */
  testClock?: ClockControl;
  timeoutMs?: number;
  onError?: (error: Error) => void;
  /** Seed an account through an isolated test service, then authenticate over HTTP. */
  provisionRegistered?: (input: RegisteredClientInput) => Promise<{
    username: string;
    password: string;
  }>;
  serverFaults?: ServerFaultControls;
}

export class HarnessEnvironment {
  readonly clock: ClockControl | undefined;
  readonly faults: HarnessFaultInjector;
  private readonly clients = new Set<SimulatedClient>();

  constructor(private readonly config: HarnessConfig) {
    this.clock = config.testClock;
    this.faults = new HarnessFaultInjector(config.serverFaults);
  }

  async createRegisteredClient(params: RegisteredClientInput): Promise<SimulatedClient> {
    const credentials = this.config.provisionRegistered
      ? await this.config.provisionRegistered(params)
      : params;
    if (!credentials.password) {
      throw new Error("Supply account credentials or an isolated account-provisioning service.");
    }
    const session = await authenticateRegistered(this.config, {
      username: credentials.username,
      password: credentials.password,
    });
    return this.addSession(session);
  }

  async createGuestClient(params: {
    displayName: string;
    token: string;
  }): Promise<SimulatedClient> {
    return this.addSession(await authenticateGuest(this.config, params));
  }

  /** Attach another real device/session without merging clients by principal ID. */
  addSession(session: SimulatedSession): SimulatedClient {
    const client = new HttpSimulatedClient(session, {
      ...this.config,
      faults: this.faults,
    });
    this.clients.add(client);
    return client;
  }

  getClients(principalId: string): readonly SimulatedClient[] {
    return Array.from(this.clients).filter((client) => client.session.principalId === principalId);
  }

  /** Select one device explicitly, or reject an ambiguous principal lookup. */
  getClient(principalId: string, cookie?: string): SimulatedClient | undefined {
    const candidates = this.getClients(principalId).filter((client) =>
      cookie === undefined || client.session.cookie === cookie);
    if (candidates.length > 1) throw new Error("Multiple harness devices match; select a session explicitly.");
    return candidates[0];
  }

  getAllClients(): readonly SimulatedClient[] {
    return Array.from(this.clients);
  }

  reset(): void {
    this.clock?.reset();
    this.faults.clearAllFaults();
    for (const client of this.clients) client.disconnectWs();
    this.clients.clear();
  }
}

// ============================================================================
// 5. Harness Scenario Fixtures (Master Spec §10 F2 H1-H6)
// ============================================================================

export interface CounterScenarioSetup {
  creator: SimulatedClient;
  peers: SimulatedClient[];
  guest: SimulatedClient;
  matchId: string;
}

/**
 * Creates a multiplayer counter scenario fixture with registered host,
 * registered peer, and guest client for H1–H4 verification.
 */
export async function setupMultiplayerCounterScenario(
  env: HarnessEnvironment,
  settings: { target?: number; turnSeconds?: number | null } = { target: 10, turnSeconds: 30 }
): Promise<CounterScenarioSetup> {
  const creator = await env.createRegisteredClient({
    username: "alice",
    displayName: "Alice (Host)",
    role: "member",
  });

  const peer = await env.createRegisteredClient({
    username: "bob",
    displayName: "Bob",
    role: "member",
  });

  const { matchId } = await creator.createMatch(
    "test-counter",
    "group",
    settings as Json,
    "instance"
  );

  await peer.joinMatch(matchId, (await creator.getSnapshot(matchId)).revision);

  const invitation = await creator.createGuestInvitation(matchId);
  const guest = await env.createGuestClient({
    displayName: "GuestCharlie",
    token: invitation.token,
  });

  return {
    creator,
    peers: [peer],
    guest,
    matchId,
  };
}

/**
 * Sets up a single-player solo counter match fixture.
 */
export async function setupSoloCounterScenario(
  env: HarnessEnvironment,
  target: number = 5
): Promise<{ client: SimulatedClient; matchId: string }> {
  const client = await env.createRegisteredClient({
    username: "solo_player",
    displayName: "Solo Player",
    role: "member",
  });

  const { matchId } = await client.createMatch(
    "test-counter",
    "solo",
    { target, turnSeconds: null } as Json,
    "instance"
  );

  return { client, matchId };
}
