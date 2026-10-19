// SPDX-License-Identifier: Apache-2.0
import type {
  Json,
  Member,
  Deadline,
  CommandReceipt,
} from "@next-round/contracts";

export type { Json, Member, Deadline, CommandReceipt };

export interface ClientCapabilities {
  canStart: boolean;
  canLeave: boolean;
  canInvite: boolean;
  canFinish: boolean;
  canChat: boolean;
  canAct: boolean;
}

export interface MatchSnapshot<V extends Json = Json> {
  id: string;
  moduleId: string;
  moduleVersion: string;
  revision: number;
  phase: "lobby" | "active" | "finished";
  mode: string;
  settings: Json;
  hostMemberId: string | null;
  members: Member[];
  deadlines: Deadline[];
  serverNow: string;
  capabilities: ClientCapabilities;
  game: V;
}

export interface ActInput {
  type: string;
  payload: Json;
  commandId: string;
  expectedRevision: number;
}

export interface GameBridge<V extends Json = Json> {
  getSnapshot(): MatchSnapshot<V>;
  subscribe(listener: (snapshot: MatchSnapshot<V>) => void): () => void;
  act(input: ActInput): Promise<CommandReceipt>;
  refresh(): Promise<MatchSnapshot<V>>;
  openPanel(panel: "chat" | "participants"): void;
}

export interface GameMountResult {
  unmount(): void;
}

export interface GameClient<V extends Json = Json> {
  mount(element: HTMLElement, bridge: GameBridge<V>): GameMountResult;
}

/**
 * Type-safe helper to define a GameClient implementation matching Master Spec §2.
 */
export function defineGameClient<V extends Json = Json>(
  client: GameClient<V>
): GameClient<V> {
  return client;
}
