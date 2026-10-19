// SPDX-License-Identifier: Apache-2.0
import type {
  CommandReceipt,
  Deadline,
  Json,
  Member,
  RuleError,
} from "@next-round/contracts";
import type {
  FinalResult,
  GameEvent,
  GameServer,
  RuleContext,
  Transition,
} from "@next-round/game-sdk";
import type {
  ActInput,
  GameBridge,
  GameClient,
  MatchSnapshot,
} from "@next-round/game-client";

// ============================================================================
// 1. Clock Control Interface and Implementations (Master Spec §10 F2)
// ============================================================================

export interface ClockControl {
  /** Return current simulated or system time as RFC 3339 UTC string with milliseconds */
  now(): string;
  /** Advance simulated time by milliseconds */
  advance(ms: number): void;
  /** Set time explicitly */
  set(time: string | Date | number): void;
  /** Reset clock to default start time */
  reset(): void;
  /** Check if clock is paused */
  isPaused(): boolean;
  /** Pause clock advancement */
  pause(): void;
  /** Resume clock advancement */
  resume(): void;
}

export class SimulatedClock implements ClockControl {
  private currentMs: number;
  private readonly defaultStartMs: number;
  private paused: boolean = false;

  constructor(initialTimeIso: string = "2026-10-18T12:00:00.000Z") {
    this.defaultStartMs = Date.parse(initialTimeIso);
    this.currentMs = this.defaultStartMs;
  }

  now(): string {
    return new Date(this.currentMs).toISOString();
  }

  advance(ms: number): void {
    if (ms < 0) {
      throw new Error("Cannot advance clock backwards.");
    }
    this.currentMs += ms;
  }

  set(time: string | Date | number): void {
    if (typeof time === "string") {
      this.currentMs = Date.parse(time);
    } else if (time instanceof Date) {
      this.currentMs = time.getTime();
    } else {
      this.currentMs = time;
    }
  }

  reset(): void {
    this.currentMs = this.defaultStartMs;
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }
}

export class SystemClock implements ClockControl {
  now(): string {
    return new Date().toISOString();
  }

  advance(_ms: number): void {
    // System clock does not manually advance
  }

  set(_time: string | Date | number): void {
    // System clock cannot be manually set
  }

  reset(): void {
    // System clock reset is a no-op
  }

  isPaused(): boolean {
    return false;
  }

  pause(): void {
    // System clock pause is a no-op
  }

  resume(): void {
    // System clock resume is a no-op
  }
}

// ============================================================================
// 2. Fault Injection Interfaces and Registry (Master Spec §10 F2, H5, F1-09)
// ============================================================================

export type FaultType =
  | "post_commit_failure"
  | "suppress_notify_wakeup"
  | "listener_disconnect"
  | "network_delay"
  | "drop_ws_connection"
  | "worker_job_retry";

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
}

export class HarnessFaultInjector implements FaultInjector {
  private readonly rules = new Map<string, FaultRule>();

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
    const id = `fault_notify_${crypto.randomUUID()}`;
    this.rules.set(id, {
      id,
      type: "suppress_notify_wakeup",
      channel,
      remainingCount: count,
      active: true,
    });
    return id;
  }

  simulateListenerDisconnect(apiProcessId: string = "default"): void {
    const id = `fault_disconnect_${crypto.randomUUID()}`;
    this.rules.set(id, {
      id,
      type: "listener_disconnect",
      apiProcessId,
      remainingCount: 1,
      active: true,
    });
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
    return this.rules.delete(id);
  }

  clearAllFaults(): void {
    this.rules.clear();
  }

  getActiveFaults(): readonly FaultRule[] {
    return Array.from(this.rules.values()).filter((r) => r.active);
  }

  shouldFault(type: FaultType, context?: Record<string, unknown>): boolean {
    for (const [id, rule] of this.rules.entries()) {
      if (!rule.active || rule.type !== type) continue;

      if (rule.matchId && context?.matchId && rule.matchId !== context.matchId) {
        continue;
      }

      if (rule.channel && context?.channel && rule.channel !== context.channel) {
        continue;
      }

      if (rule.remainingCount !== undefined) {
        rule.remainingCount -= 1;
        if (rule.remainingCount <= 0) {
          rule.active = false;
          this.rules.delete(id);
        }
      }

      return true;
    }
    return false;
  }
}

// ============================================================================
// 3. Simulated Client Interface (Master Spec §10 F2, H1, H2)
// ============================================================================

export interface SimulatedSession {
  principalId: string;
  kind: "registered" | "guest";
  displayName: string;
  username: string | null;
  guestMatchId: string | null;
  sessionToken: string;
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

  connectWs(): Promise<void>;
  disconnectWs(): void;
  reconnectWs(): Promise<void>;

  createMatch(
    moduleId: string,
    mode: string,
    settings?: Json,
    visibility?: "invite" | "instance"
  ): Promise<{ matchId: string }>;

  joinMatch(matchId: string): Promise<void>;
  startMatch(matchId: string): Promise<void>;
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
    receipt: CommandReceipt,
    action: { type: string; payload: Json }
  ): Promise<CommandReceipt>;

  leaveMatch(matchId: string): Promise<void>;
  getSnapshot(matchId: string): Promise<MatchSnapshot>;
  onSnapshot(matchId: string, listener: (snapshot: MatchSnapshot) => void): () => void;
}

export class InMemorySimulatedClient implements SimulatedClient {
  readonly session: SimulatedSession;
  readonly connectionState: ClientConnectionState = {
    wsConnected: false,
    activeMatchId: null,
  };

  private readonly _receivedSnapshots: MatchSnapshot[] = [];
  private readonly _receivedReceipts: CommandReceipt[] = [];
  private readonly snapshotListeners = new Map<string, Set<(snapshot: MatchSnapshot) => void>>();

  constructor(session: SimulatedSession) {
    this.session = session;
  }

  get receivedSnapshots(): readonly MatchSnapshot[] {
    return this._receivedSnapshots;
  }

  get receivedReceipts(): readonly CommandReceipt[] {
    return this._receivedReceipts;
  }

  async connectWs(): Promise<void> {
    this.connectionState.wsConnected = true;
  }

  disconnectWs(): void {
    this.connectionState.wsConnected = false;
  }

  async reconnectWs(): Promise<void> {
    this.disconnectWs();
    await this.connectWs();
  }

  async createMatch(
    _moduleId: string,
    _mode: string,
    _settings?: Json,
    _visibility: "invite" | "instance" = "invite"
  ): Promise<{ matchId: string }> {
    const matchId = crypto.randomUUID();
    this.connectionState.activeMatchId = matchId;
    return { matchId };
  }

  async joinMatch(matchId: string): Promise<void> {
    this.connectionState.activeMatchId = matchId;
  }

  async startMatch(_matchId: string): Promise<void> {
    // In-memory simulated transition
  }

  async act(
    matchId: string,
    action: {
      type: string;
      payload: Json;
      commandId?: string;
      expectedRevision: number;
    }
  ): Promise<CommandReceipt> {
    const commandId = action.commandId ?? crypto.randomUUID();
    const receipt: CommandReceipt = {
      commandId,
      matchId,
      committedRevision: action.expectedRevision + 1,
      replayed: false,
      outcome: "accepted",
    };
    this._receivedReceipts.push(receipt);
    return receipt;
  }

  async replayCommand(
    matchId: string,
    receipt: CommandReceipt,
    _action: { type: string; payload: Json }
  ): Promise<CommandReceipt> {
    const replayedReceipt: CommandReceipt = {
      ...receipt,
      matchId,
      replayed: true,
      outcome: "accepted",
    };
    this._receivedReceipts.push(replayedReceipt);
    return replayedReceipt;
  }

  async leaveMatch(matchId: string): Promise<void> {
    if (this.connectionState.activeMatchId === matchId) {
      this.connectionState.activeMatchId = null;
    }
  }

  async getSnapshot(matchId: string): Promise<MatchSnapshot> {
    const defaultSnapshot: MatchSnapshot = {
      id: matchId,
      moduleId: "test-counter",
      moduleVersion: "0.1.0",
      revision: 1,
      phase: "active",
      mode: "group",
      settings: { target: 10, turnSeconds: null },
      hostMemberId: this.session.principalId,
      members: [
        {
          id: this.session.principalId,
          principalId: this.session.principalId,
          kind: this.session.kind,
          displayName: this.session.displayName,
          status: "active",
          joinOrdinal: 1,
          disabled: false,
          accessEpoch: 0,
        },
      ],
      deadlines: [],
      serverNow: new Date().toISOString(),
      capabilities: {
        canStart: false,
        canLeave: true,
        canInvite: true,
        canFinish: true,
        canChat: true,
        canAct: true,
      },
      game: {
        count: 0,
        target: 10,
        turnSeconds: null,
        scores: { [this.session.principalId]: 0 },
        turnOrder: [this.session.principalId],
        currentActorMemberId: this.session.principalId,
        myMarker: "P1",
        myNote: "",
        myScore: 0,
      },
    };
    this._receivedSnapshots.push(defaultSnapshot);
    return defaultSnapshot;
  }

  onSnapshot(matchId: string, listener: (snapshot: MatchSnapshot) => void): () => void {
    let listeners = this.snapshotListeners.get(matchId);
    if (!listeners) {
      listeners = new Set();
      this.snapshotListeners.set(matchId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
    };
  }

  deliverSnapshot(matchId: string, snapshot: MatchSnapshot): void {
    this._receivedSnapshots.push(snapshot);
    const listeners = this.snapshotListeners.get(matchId);
    if (listeners) {
      for (const listener of listeners) {
        listener(snapshot);
      }
    }
  }
}

// ============================================================================
// 4. Harness Environment (Master Spec §10 F2)
// ============================================================================

export interface HarnessConfig {
  initialTime?: string;
  useSystemClock?: boolean;
}

export class HarnessEnvironment {
  readonly clock: ClockControl;
  readonly faults: FaultInjector;
  private readonly clients = new Map<string, SimulatedClient>();

  constructor(config: HarnessConfig = {}) {
    this.clock = config.useSystemClock
      ? new SystemClock()
      : new SimulatedClock(config.initialTime);
    this.faults = new HarnessFaultInjector();
  }

  async createRegisteredClient(params: {
    username: string;
    displayName: string;
    role?: "admin" | "member";
    password?: string;
  }): Promise<SimulatedClient> {
    const principalId = crypto.randomUUID();
    const session: SimulatedSession = {
      principalId,
      kind: "registered",
      displayName: params.displayName,
      username: params.username,
      guestMatchId: null,
      sessionToken: `sess_reg_${crypto.randomUUID()}`,
      csrfToken: `csrf_${crypto.randomUUID()}`,
    };

    const client = new InMemorySimulatedClient(session);
    this.clients.set(principalId, client);
    return client;
  }

  async createGuestClient(params: {
    displayName: string;
    matchId: string;
  }): Promise<SimulatedClient> {
    const principalId = crypto.randomUUID();
    const session: SimulatedSession = {
      principalId,
      kind: "guest",
      displayName: params.displayName,
      username: null,
      guestMatchId: params.matchId,
      sessionToken: `sess_guest_${crypto.randomUUID()}`,
      csrfToken: `csrf_${crypto.randomUUID()}`,
    };

    const client = new InMemorySimulatedClient(session);
    this.clients.set(principalId, client);
    return client;
  }

  getClient(principalId: string): SimulatedClient | undefined {
    return this.clients.get(principalId);
  }

  getAllClients(): readonly SimulatedClient[] {
    return Array.from(this.clients.values());
  }

  reset(): void {
    this.clock.reset();
    this.faults.clearAllFaults();
    for (const client of this.clients.values()) {
      client.disconnectWs();
    }
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
    "invite"
  );

  await peer.joinMatch(matchId);

  const guest = await env.createGuestClient({
    displayName: "GuestCharlie",
    matchId,
  });

  await guest.joinMatch(matchId);

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
