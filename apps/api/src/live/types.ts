// SPDX-License-Identifier: Apache-2.0
import type { LiveScope } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyBaseLogger } from "fastify";
import type { LiveService } from "./live-service.js";

export interface LiveSubscription {
  scope: LiveScope;
  scopeKey: string;
  lastDeliveredRevision: number;
  pendingRequestId?: string;
}

export interface LiveConnection {
  readonly id: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly socket: WebSocket;
  readonly subscriptions: Map<string, LiveSubscription>;
  missedPongs: number;
  heartbeatTimer?: NodeJS.Timeout;
  closed: boolean;
}

export interface LiveSweepStats {
  durationMs: number;
  matchCount: number;
  principalCount: number;
  connectionCount: number;
  subscriptionCount: number;
  invalidationsEmitted: number;
  revocationsEmitted: number;
  disconnectsEmitted: number;
  queryCost: {
    durationMs: number;
    queries: number;
  };
}

export interface LiveServiceOptions {
  databasePool: DatabasePool;
  databaseDirectUrl?: string;
  listenerApplicationName?: string;
  reconcileIntervalMs?: number;
  heartbeatSeconds?: number;
  maxSubscriptionsPerConnection?: number;
  maxBufferedAmount?: number;
  enableListener?: boolean;
  logger?: FastifyBaseLogger;
  onSweep?: (stats: LiveSweepStats) => void;
}

export function scopeKey(scope: LiveScope): string {
  if (scope.kind === "match") return `match:${scope.id}`;
  if (scope.kind === "chat") return `chat:${scope.id}`;
  if (scope.kind === "notifications") return "notifications";
  if (scope.kind === "home") return "home";
  throw new Error("Unknown scope kind");
}

declare module "fastify" {
  interface FastifyInstance {
    liveService: LiveService;
  }
}
