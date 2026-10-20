// SPDX-License-Identifier: Apache-2.0
import { setTimeout as delay } from "node:timers/promises";
import type { MatchService } from "./match-service.js";
import crypto from "node:crypto";
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import type {
  Permissions,
  PolicyV1,
  PrincipalView,
} from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import {
  lockPrincipals,
  recheckSession,
  type TransactionClient,
} from "./transaction-authority.js";
import {
  generateCsrfToken,
  generateOpaqueSessionToken,
  hashCsrfToken,
  hashPassword,
  hashSessionToken,
  needsPasswordRehash,
  normalizeUsername,
  timingSafeEqualBuffers,
  timingSafeEqualStrings,
  validatePassword,
  validateUsername,
  verifyDummyPassword,
  verifyPassword,
  SESSION_ABSOLUTE_EXPIRY_MS,
  SESSION_IDLE_EXPIRY_MS,
  SESSION_IDLE_REFRESH_THRESHOLD_MS,
} from "./auth.js";

const SETUP_LOCK_NAMESPACE = 0x4e525354;
const SETUP_LOCK_KEY = 1;
const CONTROL_CHARACTER = /\p{Cc}/u;

const LOGIN_USERNAME_FAILURE_LIMIT = 5;
const LOGIN_SOURCE_IP_FAILURE_LIMIT = 20;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

interface LoginBudgetSnapshot {
  count: number;
  oldest_at: Date | null;
  checked_at: Date;
}

function loginBudgetHash(
  namespace: "username" | "source-ip",
  value: string,
): Buffer {
  return crypto
    .createHash("sha256")
    .update(`login:${namespace}:`, "utf8")
    .update(value, "utf8")
    .digest();
}

function loginRetryAfterSeconds(exhausted: LoginBudgetSnapshot[]): number {
  const nextAvailableAt = Math.max(
    ...exhausted.map(
      (snapshot) =>
        snapshot.oldest_at!.getTime() + LOGIN_FAILURE_WINDOW_MS,
    ),
  );
  const checkedAt = Math.max(
    ...exhausted.map((snapshot) => snapshot.checked_at.getTime()),
  );
  return Math.max(1, Math.ceil((nextAvailableAt - checkedAt) / 1000));
}

export interface SetupInput {
  setupToken: string;
  commandId: string;
  instanceName: string;
  username: string;
  password: string;
  displayName: string;
  policy: PolicyV1;
}

export interface SetupResult {
  principal: PrincipalView;
  instance: {
    name: string;
    policyVersion: number;
    policy: PolicyV1;
  };
}

export interface LoginResult {
  principal: PrincipalView;
  permissions: Permissions;
  rawSessionToken: string;
  rawCsrfToken: string;
  expiresAt: string;
}

interface RedemptionRecovery {
  session: AuthenticatedSession;
  rawSessionToken: string;
  rawCsrfToken: string;
}

export interface AuthenticatedSession {
  id: string;
  principal: PrincipalView;
  permissions: Permissions;
  guestMatchId: string | null;
  csrfHash: Buffer;
  expiresAt: string;
}

interface SessionRow {
  session_id: string;
  principal_id: string;
  kind: "registered" | "guest";
  display_name: string;
  username: string | null;
  role: "admin" | "member" | null;
  can_invite_registrations: boolean | null;
  can_invite_guests: boolean | null;
  guest_match_id: string | null;
  csrf_hash: Buffer;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  disabled_at: Date | null;
  session_auth_epoch: string;
  principal_auth_epoch: string;
  is_expired: boolean;
}

interface AccountRow {
  principal_id: string;
  kind: "registered";
  display_name: string;
  username: string;
  password_hash: string;
  role: "admin" | "member";
  can_invite_registrations: boolean;
  can_invite_guests: boolean;
  disabled_at: Date | null;
  auth_epoch: string;
}

function principalView(row: {
  principal_id: string;
  kind: "registered" | "guest";
  display_name: string;
  username: string | null;
}): PrincipalView {
  return {
    id: row.principal_id,
    kind: row.kind,
    displayName: row.display_name,
    username: row.username,
  };
}

function permissions(row: {
  role: "admin" | "member" | null;
  can_invite_registrations: boolean | null;
  can_invite_guests: boolean | null;
}): Permissions {
  return {
    isAdmin: row.role === "admin",
    canInviteRegistrations: row.can_invite_registrations === true,
    canInviteGuests: row.can_invite_guests === true,
  };
}

function validateDisplayName(value: string): string {
  const displayName = value.trim();
  const length = Array.from(displayName).length;
  if (
    length < 1 ||
    length > 40 ||
    CONTROL_CHARACTER.test(displayName) ||
    /[<>]/.test(displayName)
  ) {
    throw new ApiError(
      ERROR_CODES.INVALID_REQUEST,
      "Display name is invalid.",
      {
        details: { fields: ["/displayName"] },
      },
    );
  }
  return displayName;
}

function validateInstanceName(value: string): string {
  const instanceName = value.trim();
  if (
    instanceName.length === 0 ||
    CONTROL_CHARACTER.test(instanceName) ||
    /[<>]/.test(instanceName)
  ) {
    throw new ApiError(
      ERROR_CODES.INVALID_REQUEST,
      "Instance name is invalid.",
      {
        details: { fields: ["/instanceName"] },
      },
    );
  }
  return instanceName;
}

export class AuthService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly setupToken: string | undefined,
    private readonly matchService: MatchService,
  ) {}

  async isConfigured(): Promise<boolean> {
    const result = await this.pool.query<{ configured: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM next_round.instance_singleton WHERE id = true) AS configured",
    );
    return result.rows[0]?.configured === true;
  }

  async setup(input: SetupInput): Promise<SetupResult> {
    if (
      (await this.isConfigured()) ||
      !this.setupToken ||
      !timingSafeEqualStrings(input.setupToken, this.setupToken)
    ) {
      throw new ApiError(ERROR_CODES.FORBIDDEN, "Setup is unavailable.");
    }

    const usernameResult = validateUsername(input.username);
    if (!usernameResult.valid || !usernameResult.normalized) {
      throw new ApiError(
        ERROR_CODES.INVALID_REQUEST,
        usernameResult.error ?? "Username is invalid.",
        {
          details: { fields: ["/username"] },
        },
      );
    }
    const passwordResult = validatePassword(input.password);
    if (!passwordResult.valid) {
      throw new ApiError(
        ERROR_CODES.INVALID_REQUEST,
        passwordResult.error ?? "Password is invalid.",
        {
          details: { fields: ["/password"] },
        },
      );
    }
    const displayName = validateDisplayName(input.displayName);
    const instanceName = validateInstanceName(input.instanceName);
    const passwordHash = await hashPassword(input.password);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
        [SETUP_LOCK_NAMESPACE, SETUP_LOCK_KEY],
      );
      const configured = await client.query(
        "SELECT 1 FROM next_round.instance_singleton WHERE id = true",
      );
      if (configured.rowCount !== 0) {
        throw new ApiError(ERROR_CODES.FORBIDDEN, "Setup is unavailable.");
      }

      const principalResult = await client.query<{
        id: string;
        kind: "registered";
        display_name: string;
      }>(
        `INSERT INTO next_round.principals (kind, display_name)
         VALUES ('registered', $1)
         RETURNING id, kind, display_name`,
        [displayName],
      );
      const principal = principalResult.rows[0];
      await client.query(
        `INSERT INTO next_round.accounts
           (principal_id, username, password_hash, role, can_invite_registrations, can_invite_guests)
         VALUES ($1, $2, $3, 'admin', true, true)`,
        [principal.id, usernameResult.normalized, passwordHash],
      );
      await client.query(
        `INSERT INTO next_round.instance_policy
           (version, instance_name, policy, changed_by)
         VALUES (1, $1, $2::jsonb, $3)`,
        [instanceName, JSON.stringify(input.policy), principal.id],
      );
      await client.query(
        "INSERT INTO next_round.instance_singleton (id, current_policy_version) VALUES (true, 1)",
      );
      await client.query(
        `INSERT INTO next_round.audit_log
           (actor_id, action, target_type, target_id, safe_metadata)
         VALUES ($1, 'instance.setup', 'instance', 'singleton', $2::jsonb)`,
        [
          principal.id,
          JSON.stringify({ commandId: input.commandId, policyVersion: 1 }),
        ],
      );
      await client.query("COMMIT");

      return {
        principal: {
          id: principal.id,
          kind: "registered",
          displayName: principal.display_name,
          username: usernameResult.normalized,
        },
        instance: {
          name: instanceName,
          policyVersion: 1,
          policy: input.policy,
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** `sourceIp` must be Fastify's trusted request.ip, never a forwarded header. */
  async login(
    usernameInput: string,
    password: string,
    sourceIp: string,
  ): Promise<LoginResult> {
    const username = normalizeUsername(usernameInput);
    const keyHashes = [
      loginBudgetHash("username", username),
      loginBudgetHash("source-ip", sourceIp),
    ];
    const lockKeys = [...new Set(
      keyHashes.map((keyHash) => keyHash.readBigInt64BE(0).toString()),
    )].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
    );
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      for (const lockKey of lockKeys) {
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          lockKey,
        ]);
      }

      const usernameBudgetResult = await client.query<LoginBudgetSnapshot>(
        `WITH instant AS (SELECT clock_timestamp() AS checked_at)
         SELECT COALESCE(sum(bucket.count), 0)::integer AS count,
                min(bucket.window_start) AS oldest_at,
                instant.checked_at
           FROM instant
           LEFT JOIN next_round.rate_buckets AS bucket
             ON bucket.key_hash = $1
            AND bucket.window_start > instant.checked_at - interval '15 minutes'
          GROUP BY instant.checked_at`,
        [keyHashes[0]],
      );
      const sourceIpBudgetResult = await client.query<LoginBudgetSnapshot>(
        `WITH instant AS (SELECT clock_timestamp() AS checked_at)
         SELECT COALESCE(sum(bucket.count), 0)::integer AS count,
                min(bucket.window_start) AS oldest_at,
                instant.checked_at
           FROM instant
           LEFT JOIN next_round.rate_buckets AS bucket
             ON bucket.key_hash = $1
            AND bucket.window_start > instant.checked_at - interval '15 minutes'
          GROUP BY instant.checked_at`,
        [keyHashes[1]],
      );
      const usernameBudget = usernameBudgetResult.rows[0]!;
      const sourceIpBudget = sourceIpBudgetResult.rows[0]!;
      const exhausted: LoginBudgetSnapshot[] = [];
      if (usernameBudget.count >= LOGIN_USERNAME_FAILURE_LIMIT)
        exhausted.push(usernameBudget);
      if (sourceIpBudget.count >= LOGIN_SOURCE_IP_FAILURE_LIMIT)
        exhausted.push(sourceIpBudget);
      if (exhausted.length > 0) {
        throw new ApiError(
          ERROR_CODES.RATE_LIMITED,
          "Too many login attempts.",
          {
            details: {
              retryAfterSeconds: loginRetryAfterSeconds(exhausted),
            },
          },
        );
      }

      const accountResult = await client.query<AccountRow>(
        `SELECT p.id AS principal_id, p.kind, p.display_name, p.disabled_at, p.auth_epoch,
                a.username, a.password_hash, a.role,
                a.can_invite_registrations, a.can_invite_guests
           FROM next_round.accounts a
           JOIN next_round.principals p ON p.id = a.principal_id
          WHERE a.username = $1`,
        [username],
      );
      const account = accountResult.rows[0];
      let credentialsValid = false;
      if (account) {
        credentialsValid = await verifyPassword(account.password_hash, password);
        if (account.disabled_at) credentialsValid = false;
      } else {
        await verifyDummyPassword(password);
      }

      if (!credentialsValid || !account) {
        for (const keyHash of keyHashes) {
          await client.query(
            `WITH attempt AS (SELECT clock_timestamp() AS occurred_at)
             INSERT INTO next_round.rate_buckets(key_hash, window_start, count, expires_at)
             SELECT $1, attempt.occurred_at, 1,
                    attempt.occurred_at + interval '15 minutes'
               FROM attempt
             ON CONFLICT (key_hash, window_start) DO UPDATE
               SET count = next_round.rate_buckets.count + 1,
                   expires_at = GREATEST(
                     next_round.rate_buckets.expires_at,
                     EXCLUDED.expires_at
                   )`,
            [keyHash],
          );
        }
        await client.query("COMMIT");
        transactionOpen = false;
        throw new ApiError(
          ERROR_CODES.INVALID_CREDENTIALS,
          "Username or password is incorrect.",
        );
      }

      if (needsPasswordRehash(account.password_hash)) {
        const replacement = await hashPassword(password);
        await client.query(
          "UPDATE next_round.accounts SET password_hash = $1, updated_at = now() WHERE principal_id = $2 AND password_hash = $3",
          [replacement, account.principal_id, account.password_hash],
        );
      }

      const now = Date.now();
      const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_EXPIRY_MS);
      const idleExpiresAt = new Date(
        Math.min(now + SESSION_IDLE_EXPIRY_MS, absoluteExpiresAt.getTime()),
      );
      const { rawToken: rawSessionToken, tokenHash } =
        generateOpaqueSessionToken();
      const { rawToken: rawCsrfToken, csrfHash } = generateCsrfToken();
      await client.query(
        `INSERT INTO next_round.sessions
           (principal_id, token_hash, csrf_hash, auth_epoch, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          account.principal_id,
          tokenHash,
          csrfHash,
          account.auth_epoch,
          idleExpiresAt,
          absoluteExpiresAt,
        ],
      );
      await client.query("COMMIT");
      transactionOpen = false;

      return {
        principal: principalView(account),
        permissions: permissions(account),
        rawSessionToken,
        rawCsrfToken,
        expiresAt: idleExpiresAt.toISOString(),
      };
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async register(
    token: string,
    usernameInput: string,
    password: string,
    displayNameInput: string,
    commandId: string,
    recovery?: RedemptionRecovery,
  ): Promise<
    LoginResult & {
      destination: { matchId: string; invitationId: string } | null;
    }
  > {
    const username = validateUsername(usernameInput);
    const validPassword = validatePassword(password);
    if (!username.valid || !username.normalized || !validPassword.valid) {
      throw new ApiError(
        ERROR_CODES.INVALID_REQUEST,
        "Registration details are invalid.",
      );
    }
    const displayName = validateDisplayName(displayNameInput);
    const passwordHash = await hashPassword(password);
    const invitationHash = hashSessionToken(token);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await this.recoverRedemption(client, "auth.registration.redeem", commandId,
        token, [usernameInput, password, displayNameInput], recovery);
      if (replay) {
        await client.query("COMMIT");
        return { ...this.recoveredLogin(recovery!), destination: replay.destination ?? null };
      }
      const pending = await client.query<{
        issuer_id: string;
        match_id: string | null;
      }>(
        `SELECT issuer_id, match_id FROM next_round.invitations
          WHERE token_hash = $1 AND kind = 'registration'`,
        [invitationHash],
      );
      const invitation = pending.rows[0];
      if (!invitation)
        throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
      await lockPrincipals(client, [invitation.issuer_id]);
      const issuer = await client.query<{
        disabled_at: Date | null;
        role: "admin" | "member";
        can_invite_registrations: boolean;
      }>(
        `SELECT p.disabled_at, a.role, a.can_invite_registrations
           FROM next_round.principals p JOIN next_round.accounts a ON a.principal_id = p.id
          WHERE p.id = $1`,
        [invitation.issuer_id],
      );
      const issuerRow = issuer.rows[0];
      if (
        !issuerRow ||
        issuerRow.disabled_at ||
        (issuerRow.role !== "admin" && !issuerRow.can_invite_registrations)
      ) {
        throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
      }
      if (invitation.match_id) {
        const activeMembership = await client.query(
          `SELECT 1 FROM next_round.match_members
            WHERE match_id = $1 AND principal_id = $2 AND status = 'active'`,
          [invitation.match_id, invitation.issuer_id],
        );
        if (!activeMembership.rowCount) {
          throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
        }
      }
      const consumed = await client.query(
        `UPDATE next_round.invitations SET status='accepted',consumed_at=now()
          WHERE token_hash=$1 AND kind='registration' AND status='pending'
            AND expires_at>clock_timestamp() RETURNING id`,
        [invitationHash],
      );
      if (!consumed.rowCount)
        throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
      const principalResult = await client.query<{
        id: string;
        display_name: string;
      }>(
        `INSERT INTO next_round.principals(kind,display_name) VALUES('registered',$1) RETURNING id,display_name`,
        [displayName],
      );
      const principalId = principalResult.rows[0]!.id;
      await client.query(
        "UPDATE next_round.invitations SET consumed_by=$2 WHERE id=$1",
        [consumed.rows[0]!.id, principalId],
      );
      await client.query(
        `INSERT INTO next_round.accounts(principal_id,username,password_hash) VALUES($1,$2,$3)`,
        [principalId, username.normalized, passwordHash],
      );
      let destination: { matchId: string; invitationId: string } | null = null;
      if (invitation.match_id) {
        const target = await client.query<{ id: string }>(
          `INSERT INTO next_round.invitations(kind,issuer_id,recipient_id,match_id,status,expires_at)
           VALUES('member',$1,$2,$3,'pending',now()+interval '7 days') RETURNING id`,
          [invitation.issuer_id, principalId, invitation.match_id],
        );
        destination = {
          matchId: invitation.match_id,
          invitationId: target.rows[0]!.id,
        };
      }
      const { rawToken: rawSessionToken, tokenHash } =
        generateOpaqueSessionToken();
      const { rawToken: rawCsrfToken, csrfHash } = generateCsrfToken();
      const now = Date.now();
      const expiresAt = new Date(now + SESSION_IDLE_EXPIRY_MS);
      const absolute = new Date(now + SESSION_ABSOLUTE_EXPIRY_MS);
      await client.query(
        `INSERT INTO next_round.sessions(principal_id,token_hash,csrf_hash,auth_epoch,idle_expires_at,absolute_expires_at)
         VALUES($1,$2,$3,0,$4,$5)`,
        [principalId, tokenHash, csrfHash, expiresAt, absolute],
      );
      await this.storeRedemption(client, principalId, "auth.registration.redeem", commandId,
        token, [usernameInput, password, displayNameInput], rawSessionToken, destination);
      await client.query(
        `INSERT INTO next_round.audit_log(actor_id,action,target_type,target_id,safe_metadata)
         VALUES($1,'registration.redeemed','invitation',$2,$3::jsonb)`,
        [principalId, consumed.rows[0]!.id, JSON.stringify({ commandId })],
      );
      await client.query("COMMIT");
      return {
        principal: {
          id: principalId,
          kind: "registered",
          displayName,
          username: username.normalized,
        },
        permissions: {
          isAdmin: false,
          canInviteRegistrations: false,
          canInviteGuests: false,
        },
        rawSessionToken,
        rawCsrfToken,
        expiresAt: expiresAt.toISOString(),
        destination,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new ApiError(
          ERROR_CODES.TOKEN_INVALID,
          "Token is invalid.",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async redeemSignInToken(
    token: string,
    commandId: string,
    recovery?: RedemptionRecovery,
  ): Promise<LoginResult> {
    const tokenHash = hashSessionToken(token);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await this.recoverRedemption(client, "auth.signin.redeem", commandId, token, [], recovery);
      if (replay) {
        await client.query("COMMIT");
        return this.recoveredLogin(recovery!);
      }
      const found = await client.query<{
        principal_id: string;
        issuer_id: string;
      }>(
        `SELECT principal_id,issuer_id FROM next_round.auth_tokens WHERE token_hash=$1 AND kind='signin'`,
        [tokenHash],
      );
      const candidate = found.rows[0];
      if (!candidate)
        throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
      await lockPrincipals(client, [
        candidate.principal_id,
        candidate.issuer_id,
      ]);
      const account = await client.query<AccountRow>(
        `SELECT p.id AS principal_id,p.kind,p.display_name,p.disabled_at,p.auth_epoch,
                a.username,a.password_hash,a.role,a.can_invite_registrations,a.can_invite_guests
           FROM next_round.principals p JOIN next_round.accounts a ON a.principal_id=p.id
          WHERE p.id=$1 AND p.disabled_at IS NULL`,
        [candidate.principal_id],
      );
      const consumed = await client.query(
        `UPDATE next_round.auth_tokens SET used_at=now()
          WHERE token_hash=$1 AND kind='signin' AND used_at IS NULL AND revoked_at IS NULL
            AND expires_at>clock_timestamp()`,
        [tokenHash],
      );
      if (!account.rowCount || consumed.rowCount !== 1)
        throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
      const result = await this.createSession(client, account.rows[0]!);
      await this.storeRedemption(client, candidate.principal_id, "auth.signin.redeem", commandId,
        token, [], result.rawSessionToken, null);
      await client.query(
        `INSERT INTO next_round.audit_log(actor_id,action,target_type,target_id,safe_metadata)
         VALUES($1,'signin_token.redeemed','principal',$2,$3::jsonb)`,
        [
          candidate.principal_id,
          candidate.principal_id,
          JSON.stringify({ commandId }),
        ],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async redeemResetToken(
    token: string,
    password: string,
    commandId: string,
    recovery?: RedemptionRecovery,
  ): Promise<void> {
    if (!validatePassword(password).valid)
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Password is invalid.");
    const passwordHash = await hashPassword(password);
    const tokenHash = hashSessionToken(token);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await this.recoverRedemption(client, "auth.reset.redeem", commandId, token, [password], recovery);
      if (replay) {
        await client.query("COMMIT");
        return;
      }
      const found = await client.query<{
        principal_id: string;
        issuer_id: string;
      }>(
        `SELECT principal_id,issuer_id FROM next_round.auth_tokens WHERE token_hash=$1 AND kind='reset'`,
        [tokenHash],
      );
      const candidate = found.rows[0];
      if (!candidate)
        throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
      await lockPrincipals(client, [
        candidate.principal_id,
        candidate.issuer_id,
      ]);
      const consumed = await client.query(
        `UPDATE next_round.auth_tokens SET used_at=now()
          WHERE token_hash=$1 AND kind='reset' AND used_at IS NULL AND revoked_at IS NULL
            AND expires_at>clock_timestamp()`,
        [tokenHash],
      );
      if (consumed.rowCount !== 1)
        throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
      const updated = await client.query(
        `UPDATE next_round.accounts a SET password_hash=$2,updated_at=now()
          FROM next_round.principals p
          WHERE a.principal_id=$1 AND p.id=a.principal_id AND p.disabled_at IS NULL`,
        [candidate.principal_id, passwordHash],
      );
      if (updated.rowCount !== 1)
        throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
      await client.query(
        `UPDATE next_round.principals SET auth_epoch=auth_epoch+1,updated_at=now() WHERE id=$1`,
        [candidate.principal_id],
      );
      await client.query(
        `UPDATE next_round.sessions SET revoked_at=now() WHERE principal_id=$1 AND revoked_at IS NULL`,
        [candidate.principal_id],
      );
      await client.query(
        `UPDATE next_round.auth_tokens SET revoked_at=now()
          WHERE principal_id=$1 AND kind IN ('signin','reset') AND used_at IS NULL AND revoked_at IS NULL`,
        [candidate.principal_id],
      );
      await client.query(
        `INSERT INTO next_round.audit_log(actor_id,action,target_type,target_id,safe_metadata)
         VALUES($1,'password.reset_completed','principal',$2,$3::jsonb)`,
        [
          candidate.principal_id,
          candidate.principal_id,
          JSON.stringify({ commandId }),
        ],
      );
      await this.storeRedemption(client, candidate.principal_id, "auth.reset.redeem", commandId,
        token, [password], null, null);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private redemptionHash(token: string, fields: string[]): Buffer {
    // The bearer is the HMAC key, so the receipt cannot be used to guess passwords.
    return crypto.createHmac("sha256", token).update(JSON.stringify(fields)).digest();
  }

  private recoveredLogin(recovery: RedemptionRecovery): LoginResult {
    return { principal: recovery.session.principal, permissions: recovery.session.permissions,
      rawSessionToken: recovery.rawSessionToken, rawCsrfToken: recovery.rawCsrfToken,
      expiresAt: recovery.session.expiresAt };
  }

  private async recoverRedemption(client: TransactionClient, scope: string, commandId: string,
    token: string, fields: string[], recovery?: RedemptionRecovery): Promise<{
      destination: { matchId: string; invitationId: string } | null;
    } | null> {
    if (!recovery) return null;
    const prior = await client.query<{ request_hash: Buffer; safe_receipt: {
      sessionId: string | null; destination: { matchId: string; invitationId: string } | null;
    } }>(`SELECT request_hash,safe_receipt FROM next_round.command_receipts
      WHERE principal_id=$1 AND scope=$2 AND command_id=$3`,
      [recovery.session.principal.id, scope, commandId]);
    const row = prior.rows[0];
    if (!row) return null;
    await lockPrincipals(client, [recovery.session.principal.id]);
    await recheckSession(client, recovery.session, { registered: true });
    this.verifyCsrf(recovery.session, recovery.rawCsrfToken);
    if (!timingSafeEqualBuffers(row.request_hash, this.redemptionHash(token, fields)))
      throw new ApiError(ERROR_CODES.IDEMPOTENCY_CONFLICT, "Command was already used.");
    if (row.safe_receipt.sessionId && row.safe_receipt.sessionId !== recovery.session.id)
      throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
    return { destination: row.safe_receipt.destination };
  }

  private async storeRedemption(client: TransactionClient, principalId: string, scope: string,
    commandId: string, token: string, fields: string[], rawSessionToken: string | null,
    destination: { matchId: string; invitationId: string } | null): Promise<void> {
    const prior = await client.query(`SELECT 1 FROM next_round.command_receipts
      WHERE principal_id=$1 AND scope=$2 AND command_id=$3`, [principalId, scope, commandId]);
    if (prior.rowCount)
      throw new ApiError(ERROR_CODES.IDEMPOTENCY_CONFLICT, "Command was already used.");
    const session = rawSessionToken ? await client.query<{ id: string }>(
      "SELECT id FROM next_round.sessions WHERE token_hash=$1", [hashSessionToken(rawSessionToken)]) : null;
    await client.query(`INSERT INTO next_round.command_receipts
      (principal_id,scope,command_id,request_hash,match_id,committed_revision,safe_receipt)
      VALUES($1,$2,$3,$4,NULL,NULL,$5::jsonb)`,
      [principalId, scope, commandId, this.redemptionHash(token, fields),
        JSON.stringify({ sessionId: session?.rows[0]?.id ?? null, destination })]);
  }

  private async createSession(
    client: TransactionClient,
    account: AccountRow,
  ): Promise<LoginResult> {
    const { rawToken: rawSessionToken, tokenHash } =
      generateOpaqueSessionToken();
    const { rawToken: rawCsrfToken, csrfHash } = generateCsrfToken();
    const now = Date.now();
    const expiresAt = new Date(now + SESSION_IDLE_EXPIRY_MS);
    const absolute = new Date(now + SESSION_ABSOLUTE_EXPIRY_MS);
    await client.query(
      `INSERT INTO next_round.sessions(principal_id,token_hash,csrf_hash,auth_epoch,idle_expires_at,absolute_expires_at)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        account.principal_id,
        tokenHash,
        csrfHash,
        account.auth_epoch,
        expiresAt,
        absolute,
      ],
    );
    return {
      principal: principalView(account),
      permissions: permissions(account),
      rawSessionToken,
      rawCsrfToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async authenticate(
    rawSessionToken: string | undefined,
  ): Promise<AuthenticatedSession> {
    if (!rawSessionToken) {
      throw new ApiError(
        ERROR_CODES.AUTH_REQUIRED,
        "Authentication is required.",
      );
    }
    const tokenHash = hashSessionToken(rawSessionToken);
    const result = await this.pool.query<SessionRow>(
      `SELECT s.id AS session_id, s.csrf_hash, s.idle_expires_at, s.absolute_expires_at,
              s.last_seen_at, s.revoked_at, s.auth_epoch AS session_auth_epoch,
              p.id AS principal_id, p.kind, p.display_name, p.disabled_at,
              p.auth_epoch AS principal_auth_epoch, p.guest_match_id,
              a.username, a.role, a.can_invite_registrations, a.can_invite_guests,
              (s.idle_expires_at <= now() OR s.absolute_expires_at <= now()) AS is_expired
         FROM next_round.sessions s
         JOIN next_round.principals p ON p.id = s.principal_id
         LEFT JOIN next_round.accounts a ON a.principal_id = p.id
        WHERE s.token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(
        ERROR_CODES.AUTH_REQUIRED,
        "Authentication is required.",
      );
    }
    if (
      row.revoked_at ||
      row.is_expired ||
      row.session_auth_epoch !== row.principal_auth_epoch
    ) {
      throw new ApiError(ERROR_CODES.SESSION_EXPIRED, "Session has expired.");
    }
    if (row.disabled_at) {
      throw new ApiError(ERROR_CODES.ACCOUNT_DISABLED, "Account is disabled.");
    }

    let expiresAt = row.idle_expires_at;
    if (
      Date.now() - row.last_seen_at.getTime() >=
      SESSION_IDLE_REFRESH_THRESHOLD_MS
    ) {
      const refreshed = await this.pool.query<{ idle_expires_at: Date }>(
        `UPDATE next_round.sessions
            SET last_seen_at = now(),
                idle_expires_at = LEAST(
                  now() + CASE
                    WHEN EXISTS (
                      SELECT 1 FROM next_round.principals p
                       WHERE p.id = sessions.principal_id AND p.kind = 'guest'
                    ) THEN interval '30 days'
                    ELSE interval '7 days'
                  END,
                  absolute_expires_at
                )
          WHERE id = $1
            AND revoked_at IS NULL
            AND idle_expires_at > clock_timestamp()
            AND absolute_expires_at > clock_timestamp()
            AND last_seen_at <= now() - interval '5 minutes'
          RETURNING idle_expires_at`,
        [row.session_id],
      );
      expiresAt = refreshed.rows[0]?.idle_expires_at ?? expiresAt;
    }

    return {
      id: row.session_id,
      principal: principalView(row),
      permissions: permissions(row),
      guestMatchId: row.guest_match_id,
      csrfHash: row.csrf_hash,
      expiresAt: expiresAt.toISOString(),
    };
  }

  verifyCsrf(
    session: AuthenticatedSession,
    rawCsrfToken: string | undefined,
  ): void {
    if (
      !rawCsrfToken ||
      !timingSafeEqualBuffers(session.csrfHash, hashCsrfToken(rawCsrfToken))
    ) {
      throw new ApiError(ERROR_CODES.FORBIDDEN, "CSRF token is invalid.");
    }
  }

  async rotateCsrf(session: AuthenticatedSession): Promise<string> {
    const { rawToken, csrfHash } = generateCsrfToken();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      await recheckSession(client, session);
      await client.query(
        "UPDATE next_round.sessions SET csrf_hash = $1 WHERE id = $2",
        [csrfHash, session.id],
      );
      await client.query("COMMIT");
      return rawToken;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async logout(session: AuthenticatedSession): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      await recheckSession(client, session);
      await client.query(
        "UPDATE next_round.sessions SET revoked_at = now() WHERE id = $1",
        [session.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async authorizeGame(
    session: AuthenticatedSession,
    gameId?: string,
    version?: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      const current = await recheckSession(client, session);
      if (current.kind === "guest") {
        const pinned = await client.query(
          `SELECT 1 FROM next_round.matches m
             JOIN next_round.match_members mm ON mm.match_id = m.id
             JOIN next_round.principals p ON p.id = mm.principal_id
            WHERE p.id = $1 AND m.id = p.guest_match_id AND mm.status = 'active'
              AND m.module_id = $2 AND m.module_version = $3`,
          [session.principal.id, gameId ?? null, version ?? null],
        );
        if (pinned.rowCount !== 1)
          throw new ApiError(ERROR_CODES.FORBIDDEN, "Access is not permitted.");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setUserDisabled(
    actor: AuthenticatedSession,
    principalId: string,
    disabled?: boolean,
    changes: {
      role?: "admin" | "member";
      canInviteRegistrations?: boolean;
      canInviteGuests?: boolean;
    } = {},
  ): Promise<PrincipalView & { disabled: boolean }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.setUserDisabledOnce(actor, principalId, disabled, changes);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "40001" && code !== "40P01") throw error;
        if (attempt === 2) {
          throw new ApiError(ERROR_CODES.SERVICE_UNAVAILABLE, "Please retry this command.");
        }
        await delay(10 + Math.random() * 30);
      }
    }
  }

  private async setUserDisabledOnce(
    actor: AuthenticatedSession,
    principalId: string,
    disabled?: boolean,
    changes: {
      role?: "admin" | "member";
      canInviteRegistrations?: boolean;
      canInviteGuests?: boolean;
    } = {},
  ): Promise<PrincipalView & { disabled: boolean }> {
    if (!actor.permissions.isAdmin) {
      throw new ApiError(
        ERROR_CODES.FORBIDDEN,
        "Administrator access is required.",
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const adminCandidates = await client.query<{ principal_id: string }>(
        "SELECT principal_id FROM next_round.accounts WHERE role = 'admin'",
      );
      const matchPrincipals = await client.query<{ principal_id: string }>(
        `SELECT DISTINCT mm.principal_id
           FROM next_round.match_members target
           JOIN next_round.matches m ON m.id=target.match_id
           JOIN next_round.match_members mm ON mm.match_id=m.id
          WHERE target.principal_id=$1 AND target.status='active' AND m.phase<>'finished'`,
        [principalId],
      );
      const lockedPrincipalIds = [
        actor.principal.id, principalId,
        ...adminCandidates.rows.map((row) => row.principal_id),
        ...matchPrincipals.rows.map((row) => row.principal_id),
      ];
      await lockPrincipals(client, lockedPrincipalIds);
      await recheckSession(client, actor, { registered: true, admin: true });
      const enabledAdmins = await client.query<{ principal_id: string }>(
        `SELECT a.principal_id
           FROM next_round.accounts a
           JOIN next_round.principals p ON p.id = a.principal_id
          WHERE a.role = 'admin' AND p.disabled_at IS NULL
          ORDER BY a.principal_id
          FOR UPDATE OF p, a`,
      );
      const targetResult = await client.query<{
        principal_id: string;
        kind: "registered";
        display_name: string;
        username: string;
        role: "admin" | "member";
        can_invite_registrations: boolean;
        can_invite_guests: boolean;
        disabled_at: Date | null;
      }>(
        `SELECT p.id AS principal_id, p.kind, p.display_name, p.disabled_at, a.username, a.role,
                a.can_invite_registrations, a.can_invite_guests
           FROM next_round.principals p
           JOIN next_round.accounts a ON a.principal_id = p.id
          WHERE p.id = $1
          FOR UPDATE OF p, a`,
        [principalId],
      );
      const target = targetResult.rows[0];
      if (!target) {
        throw new ApiError(ERROR_CODES.NOT_FOUND, "User was not found.");
      }
      const nextDisabled = disabled ?? Boolean(target.disabled_at);
      const nextRole = changes.role ?? target.role;
      if (
        (nextDisabled || nextRole !== "admin") &&
        !target.disabled_at &&
        target.role === "admin" &&
        enabledAdmins.rowCount === 1
      ) {
        throw new ApiError(
          ERROR_CODES.RULE_REJECTED,
          "The last enabled administrator cannot be removed.",
        );
      }
      const nextCanInviteRegistrations =
        changes.canInviteRegistrations ?? target.can_invite_registrations;
      const registrationPermissionLost =
        (target.role === "admin" || target.can_invite_registrations) &&
        nextRole !== "admin" &&
        !nextCanInviteRegistrations;
      const nextCanInviteGuests =
        changes.canInviteGuests ?? target.can_invite_guests;
      const guestPermissionLost =
        (target.role === "admin" || target.can_invite_guests) &&
        nextRole !== "admin" &&
        !nextCanInviteGuests;
      const disabledChanged = nextDisabled !== Boolean(target.disabled_at);
      const permissionChanged =
        nextRole !== target.role ||
        (changes.canInviteRegistrations !== undefined &&
          changes.canInviteRegistrations !== target.can_invite_registrations) ||
        (changes.canInviteGuests !== undefined &&
          changes.canInviteGuests !== target.can_invite_guests);
      await client.query(
        `UPDATE next_round.principals
            SET disabled_at = CASE WHEN $2 THEN COALESCE(disabled_at,now()) ELSE NULL END,
                auth_epoch = auth_epoch + CASE WHEN $3 THEN 1 ELSE 0 END,
                updated_at = now()
          WHERE id = $1`,
        [principalId, nextDisabled, disabledChanged],
      );
      await client.query(
        `UPDATE next_round.accounts
            SET role=$2,
                can_invite_registrations=COALESCE($3,can_invite_registrations),
                can_invite_guests=COALESCE($4,can_invite_guests),
                updated_at=now()
          WHERE principal_id=$1`,
        [
          principalId,
          nextRole,
          changes.canInviteRegistrations ?? null,
          changes.canInviteGuests ?? null,
        ],
      );
      if (disabledChanged && nextDisabled) {
        await client.query(
          "UPDATE next_round.sessions SET revoked_at=now() WHERE principal_id=$1 AND revoked_at IS NULL",
          [principalId],
        );
        await client.query(
          `UPDATE next_round.invitations SET status='revoked'
            WHERE status='pending' AND (issuer_id=$1 OR recipient_id=$1)`,
          [principalId],
        );
      }
      if (registrationPermissionLost || (disabledChanged && nextDisabled)) {
        await client.query(
          `UPDATE next_round.invitations SET status='revoked'
            WHERE issuer_id=$1 AND kind='registration' AND status='pending'`,
          [principalId],
        );
      }
      if (guestPermissionLost || (disabledChanged && nextDisabled)) {
        await client.query(
          `UPDATE next_round.invitations SET status='revoked'
            WHERE issuer_id=$1 AND kind='guest' AND status='pending'`,
          [principalId],
        );
      }
      if (
        disabledChanged ||
        registrationPermissionLost ||
        guestPermissionLost ||
        permissionChanged
      ) {
        await client.query(
          `UPDATE next_round.auth_tokens SET revoked_at=now()
            WHERE (issuer_id=$1 OR principal_id=$1) AND used_at IS NULL AND revoked_at IS NULL`,
          [principalId],
        );
        await client.query(
          `INSERT INTO next_round.audit_log(actor_id,action,target_type,target_id,safe_metadata)
           VALUES($1,'user.access_changed','principal',$2,$3::jsonb)`,
          [
            actor.principal.id,
            principalId,
            JSON.stringify({
              disabled: nextDisabled,
              role: nextRole,
              canInviteRegistrations:
                changes.canInviteRegistrations ??
                target.can_invite_registrations,
              canInviteGuests:
                changes.canInviteGuests ?? target.can_invite_guests,
            }),
          ],
        );
      }
      if (disabledChanged) {
        await this.matchService.applyPrincipalStatusInTransaction(
          client, principalId, nextDisabled, lockedPrincipalIds,
        );
      }
      await client.query("COMMIT");
      return {
        id: target.principal_id,
        kind: target.kind,
        displayName: target.display_name,
        username: target.username,
        disabled: nextDisabled,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
