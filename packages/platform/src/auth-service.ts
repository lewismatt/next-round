// SPDX-License-Identifier: Apache-2.0
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import type { Permissions, PolicyV1, PrincipalView } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
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
  if (length < 1 || length > 40 || CONTROL_CHARACTER.test(displayName) || /[<>]/.test(displayName)) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Display name is invalid.", {
      details: { fields: ["/displayName"] },
    });
  }
  return displayName;
}

function validateInstanceName(value: string): string {
  const instanceName = value.trim();
  if (instanceName.length === 0 || CONTROL_CHARACTER.test(instanceName) || /[<>]/.test(instanceName)) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Instance name is invalid.", {
      details: { fields: ["/instanceName"] },
    });
  }
  return instanceName;
}

export class AuthService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly setupToken: string | undefined,
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
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, usernameResult.error ?? "Username is invalid.", {
        details: { fields: ["/username"] },
      });
    }
    const passwordResult = validatePassword(input.password);
    if (!passwordResult.valid) {
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, passwordResult.error ?? "Password is invalid.", {
        details: { fields: ["/password"] },
      });
    }
    const displayName = validateDisplayName(input.displayName);
    const instanceName = validateInstanceName(input.instanceName);
    const passwordHash = await hashPassword(input.password);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [
        SETUP_LOCK_NAMESPACE,
        SETUP_LOCK_KEY,
      ]);
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
        [principal.id, JSON.stringify({ commandId: input.commandId, policyVersion: 1 })],
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

  async login(usernameInput: string, password: string): Promise<LoginResult> {
    const username = normalizeUsername(usernameInput);
    const accountResult = await this.pool.query<AccountRow>(
      `SELECT p.id AS principal_id, p.kind, p.display_name, p.disabled_at, p.auth_epoch,
              a.username, a.password_hash, a.role,
              a.can_invite_registrations, a.can_invite_guests
         FROM next_round.accounts a
         JOIN next_round.principals p ON p.id = a.principal_id
        WHERE a.username = $1`,
      [username],
    );
    const account = accountResult.rows[0];
    if (!account) {
      await verifyDummyPassword(password);
      throw new ApiError(ERROR_CODES.INVALID_CREDENTIALS, "Username or password is incorrect.");
    }
    if (!(await verifyPassword(account.password_hash, password)) || account.disabled_at) {
      throw new ApiError(ERROR_CODES.INVALID_CREDENTIALS, "Username or password is incorrect.");
    }

    if (needsPasswordRehash(account.password_hash)) {
      const replacement = await hashPassword(password);
      await this.pool.query(
        "UPDATE next_round.accounts SET password_hash = $1, updated_at = now() WHERE principal_id = $2 AND password_hash = $3",
        [replacement, account.principal_id, account.password_hash],
      );
    }

    const now = Date.now();
    const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_EXPIRY_MS);
    const idleExpiresAt = new Date(Math.min(now + SESSION_IDLE_EXPIRY_MS, absoluteExpiresAt.getTime()));
    const { rawToken: rawSessionToken, tokenHash } = generateOpaqueSessionToken();
    const { rawToken: rawCsrfToken, csrfHash } = generateCsrfToken();
    await this.pool.query(
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

    return {
      principal: principalView(account),
      permissions: permissions(account),
      rawSessionToken,
      rawCsrfToken,
      expiresAt: idleExpiresAt.toISOString(),
    };
  }

  async authenticate(rawSessionToken: string | undefined): Promise<AuthenticatedSession> {
    if (!rawSessionToken) {
      throw new ApiError(ERROR_CODES.AUTH_REQUIRED, "Authentication is required.");
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
      throw new ApiError(ERROR_CODES.AUTH_REQUIRED, "Authentication is required.");
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
    if (Date.now() - row.last_seen_at.getTime() >= SESSION_IDLE_REFRESH_THRESHOLD_MS) {
      const refreshed = await this.pool.query<{ idle_expires_at: Date }>(
        `UPDATE next_round.sessions
            SET last_seen_at = now(),
                idle_expires_at = LEAST(now() + interval '7 days', absolute_expires_at)
          WHERE id = $1
            AND revoked_at IS NULL
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

  verifyCsrf(session: AuthenticatedSession, rawCsrfToken: string | undefined): void {
    if (!rawCsrfToken || !timingSafeEqualBuffers(session.csrfHash, hashCsrfToken(rawCsrfToken))) {
      throw new ApiError(ERROR_CODES.FORBIDDEN, "CSRF token is invalid.");
    }
  }

  async rotateCsrf(sessionId: string): Promise<string> {
    const { rawToken, csrfHash } = generateCsrfToken();
    await this.pool.query(
      "UPDATE next_round.sessions SET csrf_hash = $1 WHERE id = $2 AND revoked_at IS NULL",
      [csrfHash, sessionId],
    );
    return rawToken;
  }

  async logout(sessionId: string): Promise<void> {
    await this.pool.query(
      "UPDATE next_round.sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [sessionId],
    );
  }

  async setUserDisabled(actor: AuthenticatedSession, principalId: string, disabled: boolean): Promise<PrincipalView> {
    if (!actor.permissions.isAdmin) {
      throw new ApiError(ERROR_CODES.FORBIDDEN, "Administrator access is required.");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
        disabled_at: Date | null;
      }>(
        `SELECT p.id AS principal_id, p.kind, p.display_name, p.disabled_at, a.username, a.role
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
      if (disabled && !target.disabled_at && target.role === "admin" && enabledAdmins.rowCount === 1) {
        throw new ApiError(ERROR_CODES.RULE_REJECTED, "The last enabled administrator cannot be disabled.");
      }

      if (disabled !== Boolean(target.disabled_at)) {
        await client.query(
          `UPDATE next_round.principals
              SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END,
                  auth_epoch = auth_epoch + 1,
                  updated_at = now()
            WHERE id = $1`,
          [principalId, disabled],
        );
        if (disabled) {
          await client.query(
            "UPDATE next_round.sessions SET revoked_at = now() WHERE principal_id = $1 AND revoked_at IS NULL",
            [principalId],
          );
          await client.query(
            `UPDATE next_round.invitations
                SET status = 'revoked'
              WHERE status = 'pending' AND (issuer_id = $1 OR recipient_id = $1)`,
            [principalId],
          );
        }
        await client.query(
          `INSERT INTO next_round.audit_log
             (actor_id, action, target_type, target_id, safe_metadata)
           VALUES ($1, 'user.disabled_changed', 'principal', $2, $3::jsonb)`,
          [actor.principal.id, principalId, JSON.stringify({ disabled })],
        );
      }
      await client.query("COMMIT");
      return {
        id: target.principal_id,
        kind: target.kind,
        displayName: target.display_name,
        username: target.username,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
