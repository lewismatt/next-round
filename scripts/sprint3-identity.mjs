// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";

const command = () => randomUUID();
const cookieValue = (cookie) =>
  cookie.split(";")[0].slice(cookie.split(";")[0].indexOf("=") + 1);
const cookieDigest = (cookie) =>
  createHash("sha256").update(cookieValue(cookie)).digest();
const timestamp = (value) =>
  value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
const minutes = (from, to) => (timestamp(to) - timestamp(from)) / 60_000;
const tokenFromUrl = (value) => {
  const url = new URL(value);
  const token = url.hash.slice(1);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invitation URL has no valid token fragment.");
  return token;
};

export async function runIdentityAcceptance(ctx) {
  const {
    assert,
    cases,
    measure,
    pool,
    request,
    host,
    peer,
    env,
    scenario,
    accounts,
    until,
  } = ctx;
  const run = async (name, checks, action) => {
    // Each case is an isolated fixture; the shared production budget is exercised below.
    await pool.query("DELETE FROM next_round.rate_buckets");
    await measure(`${name}`, checks, action);
    cases.at(-1).requirement = name.slice(0, 2);
  };
  const assertTtl = async (expiresAt, expectedMs, label) => {
    const now = (await pool.query("SELECT now() AS now")).rows[0].now;
    const actualMs = timestamp(expiresAt) - timestamp(now);
    assert.ok(
      Math.abs(actualMs - expectedMs) <= 5_000,
      `${label} TTL must be within five seconds of expected; actual ${actualMs}ms`,
    );
  };
  /**
   * Asserts that a stored expiry equals the database clock plus a calendar
   * interval (for example "30 days"). Production computes these expiries
   * with SQL interval arithmetic, so the expected value is computed by
   * PostgreSQL itself and follows the database's own timezone and DST
   * rules. An absolute millisecond window silently assumes a UTC database:
   * across the autumn DST fall-back a calendar "30 days" measures 30.0417
   * absolute days (BL-026).
   */
  const assertDbInterval = async (expiresAt, interval, label) => {
    const expected = (
      await pool.query("SELECT clock_timestamp() + $1::interval AS expected", [
        interval,
      ])
    ).rows[0].expected;
    const deltaMs = Math.abs(timestamp(expiresAt) - timestamp(expected));
    assert.ok(
      deltaMs <= 60_000,
      `${label} expiry must equal the database clock plus ${interval} (within 60s); delta ${deltaMs}ms`,
    );
  };
  const adminRequest = (path, body, client = host) =>
    request(`/api/v1${path}`, {
      method: "POST",
      body: { commandId: command(), ...body },
      client,
    });
  const adminPatch = (path, body, client = host) =>
    request(`/api/v1${path}`, {
      method: "PATCH",
      body,
      client,
    });
  const unauthenticated = (path, body, base) =>
    request(`/api/v1${path}`, {
      method: "POST",
      base,
      body: { commandId: command(), ...body },
      headers: {
        origin: new URL(base).origin,
        "content-type": "application/json",
      },
    });
  const guestFixture = async (settings = { target: 10, turnSeconds: 60 }) => {
    const match = await scenario.creator.createMatch(
      "test-counter",
      "group",
      settings,
      "instance",
    );
    const invitation = await scenario.creator.createGuestInvitation(
      match.matchId,
    );
    return { matchId: match.matchId, invitation };
  };
  const raceUnderLock = async (table, digest, attempts, label) => {
    const blocker = await pool.connect();
    let requests;
    let committed = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT token_hash FROM next_round.${table} WHERE token_hash=$1 FOR UPDATE`,
        [digest],
      );
      requests = Promise.all(attempts.map((attempt) => attempt()));
      await until(async () => {
        const result = await pool.query(
          `SELECT count(*)::int AS waiting
             FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
              AND state='active' AND wait_event_type='Lock'
              AND (query ILIKE $1 OR query ILIKE '%next_round.principals%')`,
          [`%next_round.${table}%`],
        );
        return result.rows[0].waiting >= attempts.length;
      }, `${label} overlapping HTTP redemptions blocked on the locked ${table} row`);
      await blocker.query("COMMIT");
      committed = true;
      return await requests;
    } finally {
      if (!committed) await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      if (requests) await Promise.allSettled([requests]);
    }
  };
  await run("H1: cluster-shared token redemption budget", [
    "ten invalid attempts share one IP budget across both API processes",
    "the eleventh attempt is rate limited by PostgreSQL",
  ], async () => {
    for (let attempt = 0; attempt < 11; attempt++) {
      const response = await unauthenticated("/auth/qr/redeem", {
        token: "0".repeat(64),
      }, attempt % 2 === 0 ? ctx.apiA.url : ctx.apiB.url);
      assert.equal(response.status, attempt < 10 ? 410 : 429);
    }
  });

  const registrationMatch = await scenario.creator.createMatch(
    "test-counter",
    "group",
    { target: 10, turnSeconds: 60 },
    "instance",
  );
  const registration = await adminRequest(
    "/invitations/registration",
    { matchId: registrationMatch.matchId },
    scenario.creator,
  );
  assert.equal(
    registration.status,
    201,
    "authorized match member can issue production registration invitation",
  );
  const reg = (await registration.json()).data;
  await assertDbInterval(reg.expiresAt, "7 days", "registration invitation");
  const regToken = tokenFromUrl(reg.url);
  assert.ok(regToken.length >= 32);

  await run(
    "H1:registration-invitation-single-consumption",
    [
      "production registration invitation has seven-day expiry and a match destination",
      "parallel redemption consumes one token exactly once",
      "successful registration remains signed in with its intended destination",
    ],
    async () => {
      const digest = createHash("sha256").update(regToken).digest();
      const attempts = await raceUnderLock(
        "invitations",
        digest,
        ["s3_race_a", "s3_race_b"].map(
          (username, index) => () =>
            unauthenticated(
              "/auth/register",
              {
                token: regToken,
                username,
                password: "acceptance-password-92",
                displayName: username,
              },
              index === 0 ? ctx.apiA.url : ctx.apiB.url,
            ),
        ),
        "registration",
      );
      const statuses = attempts.map((response) => response.status);
      assert.equal(
        statuses.filter((status) => status === 201).length,
        1,
        `one concurrent registration must succeed, got ${statuses.join(",")}`,
      );
      assert.equal(
        statuses.filter((status) => status === 410).length,
        1,
        `parallel losing redemption must report TOKEN_INVALID, got ${statuses.join(",")}`,
      );
      const created = await pool.query(
        "SELECT username FROM next_round.accounts WHERE username=ANY($1::text[])",
        [["s3_race_a", "s3_race_b"]],
      );
      assert.equal(
        created.rowCount,
        1,
        "registration creates exactly one account",
      );
      const winner = attempts[statuses.indexOf(201)];
      assert.ok(
        winner.headers.get("set-cookie"),
        "successful registration sets authenticated session cookie",
      );
      const registered = (await winner.json()).data;
      assert.equal(
        registered.destination.matchId,
        registrationMatch.matchId,
        "registration destination is preserved",
      );
      const issuedQr = await adminRequest(
        `/admin/users/${registered.principal.id}/sign-in-qr`,
        {},
      );
      assert.equal(issuedQr.status, 201);
      const qrToken = tokenFromUrl((await issuedQr.json()).data.url);
      const signedIn = await unauthenticated(
        "/auth/qr/redeem",
        { token: qrToken },
        ctx.apiB.url,
      );
      assert.equal(
        signedIn.status,
        200,
        "new account signs in through the second production API",
      );
      assert.ok(
        signedIn.headers.get("set-cookie"),
        "QR sign-in sets session cookie for destination admission",
      );
      const signedInData = (await signedIn.json()).data;
      assert.equal(signedInData.principal.id, registered.principal.id);
      assert.ok(
        signedInData.csrfToken,
        "QR sign-in returns CSRF token for destination admission",
      );
      const destination = registered.destination;
      const snapshot = await scenario.creator.getSnapshot(destination.matchId);
      const accepted = await request(
        `/api/v1/invitations/${destination.invitationId}/accept`,
        {
          method: "POST",
          body: { commandId: command(), expectedRevision: snapshot.revision },
          headers: {
            origin: new URL(ctx.apiB.url).origin,
            cookie: signedIn.headers.get("set-cookie").split(";")[0],
            ...(signedInData.csrfToken
              ? { "x-csrf-token": signedInData.csrfToken }
              : {}),
          },
          base: ctx.apiB.url,
        },
      );
      assert.equal(
        accepted.status,
        200,
        "registered user accepts the preserved targeted match destination",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM next_round.invitations WHERE id=$1",
            [destination.invitationId],
          )
        ).rows[0].status,
        "accepted",
        "destination invitation is consumed by production admission",
      );
    },
  );

  await run(
    "H1:registration-invitation-expiry",
    [
      "expired seven-day registration invitation is rejected by production redemption",
    ],
    async () => {
      const issued = await adminRequest("/invitations/registration", {});
      assert.equal(issued.status, 201);
      const invite = (await issued.json()).data;
      await pool.query(
        "UPDATE next_round.invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
        [invite.id],
      );
      const response = await unauthenticated(
        "/auth/register",
        {
          token: tokenFromUrl(invite.url),
          username: "s3_expired_reg",
          password: "acceptance-password-92",
          displayName: "expired",
        },
        ctx.apiB.url,
      );
      assert.equal(
        response.status,
        410,
        "expired registration token returns TOKEN_INVALID",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM next_round.accounts WHERE username='s3_expired_reg'",
          )
        ).rowCount,
        0,
      );
    },
  );

  await run(
    "H1:sign-in-qr-reissue-and-expiry",
    [
      "admin-issued QR token lasts fifteen minutes and authenticates same principal",
      "expired QR token is rejected",
    ],
    async () => {
      const target = scenario.creator;
      const issue = () =>
        adminRequest(
          `/admin/users/${target.session.principalId}/sign-in-qr`,
          {},
        );
      const first = await issue();
      assert.equal(first.status, 201);
      const firstData = (await first.json()).data;
      assert.ok(
        minutes(Date.now(), firstData.expiresAt) > 14.99 &&
          minutes(Date.now(), firstData.expiresAt) < 15.01,
      );
      await assertTtl(firstData.expiresAt, 15 * 60 * 1000, "sign-in QR");
      const expiredToken = tokenFromUrl(firstData.url);
      const digest = createHash("sha256").update(expiredToken).digest();
      await pool.query(
        "UPDATE next_round.auth_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [digest],
      );
      const rejected = await unauthenticated(
        "/auth/qr/redeem",
        { token: expiredToken },
        ctx.apiB.url,
      );
      assert.equal(
        rejected.status,
        410,
        "expired QR token returns TOKEN_INVALID",
      );
      const fresh = await issue();
      assert.equal(fresh.status, 201);
      const freshToken = tokenFromUrl((await fresh.json()).data.url);
      const freshDigest = createHash("sha256").update(freshToken).digest();
      const attempts = await raceUnderLock(
        "auth_tokens",
        freshDigest,
        [
          () =>
            unauthenticated(
              "/auth/qr/redeem",
              { token: freshToken },
              ctx.apiA.url,
            ),
          () =>
            unauthenticated(
              "/auth/qr/redeem",
              { token: freshToken },
              ctx.apiB.url,
            ),
        ],
        "QR",
      );
      assert.deepEqual(
        attempts.map((response) => response.status).sort((a, b) => a - b),
        [200, 410],
        "concurrent QR redemptions have one winner and one TOKEN_INVALID loser",
      );
      const redeemed = attempts.find((response) => response.status === 200);
      assert.equal(
        (await redeemed.json()).data.principal.id,
        target.session.principalId,
      );
      assert.ok(redeemed.headers.get("set-cookie"));
    },
  );

  await run(
    "H1:password-reset-expiry-reissue-and-session-revocation",
    [
      "reset token has thirty-minute expiry",
      "reset reissue revokes prior reset token",
      "successful reset redeems token and revokes existing sessions",
      "expired reset token is rejected without password mutation",
    ],
    async () => {
      const resetAccount = accounts.find(
        (account) => account.username === "s3_reset",
      );
      const target = await env.createRegisteredClient({
        username: resetAccount.username,
        displayName: "Reset Target",
      });
      const issued = await adminRequest(
        `/admin/users/${target.session.principalId}/reset`,
        {},
      );
      assert.equal(issued.status, 201);
      const issuedData = (await issued.json()).data;
      assert.ok(
        minutes(Date.now(), issuedData.expiresAt) > 29.99 &&
          minutes(Date.now(), issuedData.expiresAt) < 30.01,
      );
      await assertTtl(issuedData.expiresAt, 30 * 60 * 1000, "password reset");
      const token = tokenFromUrl(issuedData.url);
      const digest = createHash("sha256").update(token).digest();
      const current = await adminRequest(
        `/admin/users/${target.session.principalId}/reset`,
        {},
      );
      assert.equal(current.status, 201);
      const currentData = (await current.json()).data;
      const currentToken = tokenFromUrl(currentData.url);
      assert.ok(
        (
          await pool.query(
            "SELECT revoked_at FROM next_round.auth_tokens WHERE token_hash=$1",
            [digest],
          )
        ).rows[0].revoked_at,
        "reset reissue revokes previous outstanding reset token",
      );
      const qrIssued = await adminRequest(
        `/admin/users/${target.session.principalId}/sign-in-qr`,
        {},
      );
      assert.equal(qrIssued.status, 201);
      const qrToken = tokenFromUrl((await qrIssued.json()).data.url);
      const qrDigest = createHash("sha256").update(qrToken).digest();
      const currentDigest = createHash("sha256").update(currentToken).digest();
      const resetAttempts = await raceUnderLock(
        "auth_tokens",
        currentDigest,
        [
          () =>
            unauthenticated(
              "/auth/reset/redeem",
              { token: currentToken, password: "acceptance-password-93" },
              ctx.apiA.url,
            ),
          () =>
            unauthenticated(
              "/auth/reset/redeem",
              { token: currentToken, password: "acceptance-password-93" },
              ctx.apiB.url,
            ),
        ],
        "password reset",
      );
      assert.deepEqual(
        resetAttempts.map((response) => response.status).sort((a, b) => a - b),
        [204, 410],
        "concurrent reset redemptions have one winner and one TOKEN_INVALID loser",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT revoked_at FROM next_round.auth_tokens WHERE token_hash=$1",
            [qrDigest],
          )
        ).rows[0].revoked_at !== null,
        true,
        "password reset revokes outstanding sign-in QR tokens",
      );
      const sessionHash = cookieDigest(target.session.cookie);
      const sessions = await pool.query(
        "SELECT revoked_at FROM next_round.sessions WHERE token_hash=$1",
        [sessionHash],
      );
      assert.ok(
        sessions.rowCount === 0 || sessions.rows[0].revoked_at,
        "password reset revokes existing session",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM next_round.auth_tokens WHERE principal_id=$1 AND kind='reset' AND used_at IS NULL AND revoked_at IS NULL",
            [target.session.principalId],
          )
        ).rows[0].count,
        0,
        "completed reset leaves no outstanding reset token",
      );
      const expiredIssued = await adminRequest(
        `/admin/users/${target.session.principalId}/reset`,
        {},
      );
      assert.equal(expiredIssued.status, 201);
      const expiredToken = tokenFromUrl((await expiredIssued.json()).data.url);
      const expiredDigest = createHash("sha256").update(expiredToken).digest();
      await pool.query(
        "UPDATE next_round.auth_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [expiredDigest],
      );
      const expired = await unauthenticated(
        "/auth/reset/redeem",
        { token: expiredToken, password: "acceptance-password-94" },
        ctx.apiA.url,
      );
      assert.equal(
        expired.status,
        410,
        "expired reset token returns TOKEN_INVALID",
      );
    },
  );

  await run(
    "H1:guest-invitation-expiry",
    [
      "production guest invite is valid for fifteen minutes",
      "expired fifteen-minute guest invitation returns TOKEN_INVALID",
    ],
    async () => {
      const { invitation } = await guestFixture();
      const inviteDigest = createHash("sha256")
        .update(invitation.token)
        .digest();
      const inviteRow = (
        await pool.query(
          "SELECT expires_at FROM next_round.invitations WHERE token_hash=$1",
          [inviteDigest],
        )
      ).rows[0];
      assert.ok(
        minutes(Date.now(), inviteRow.expires_at) > 14.99 &&
          minutes(Date.now(), inviteRow.expires_at) < 15.01,
      );
      await assertTtl(inviteRow.expires_at, 15 * 60 * 1000, "guest invitation");
      const guestAttempts = await raceUnderLock(
        "invitations",
        inviteDigest,
        [
          () =>
            unauthenticated(
              "/guest-invitations/redeem",
              { token: invitation.token, displayName: "GuestRaceA" },
              ctx.apiA.url,
            ),
          () =>
            unauthenticated(
              "/guest-invitations/redeem",
              { token: invitation.token, displayName: "GuestRaceB" },
              ctx.apiB.url,
            ),
        ],
        "guest invitation",
      );
      assert.deepEqual(
        guestAttempts.map((response) => response.status).sort((a, b) => a - b),
        [200, 410],
        "concurrent guest invitation redemptions have one winner and one TOKEN_INVALID loser",
      );
      const { invitation: expiredInvite } = await guestFixture();
      const expiredHash = createHash("sha256")
        .update(expiredInvite.token)
        .digest();
      await pool.query(
        "UPDATE next_round.invitations SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [expiredHash],
      );
      const denied = await unauthenticated(
        "/guest-invitations/redeem",
        {
          token: expiredInvite.token,
          displayName: "ExpiredGuest",
        },
        ctx.apiB.url,
      );
      assert.equal(
        denied.status,
        410,
        "expired guest invitation returns TOKEN_INVALID",
      );
    },
  );
  await run(
    "H2:guest-session-30-day-idle-and-180-day-absolute-lifetime",
    [
      "production guest redemption persists thirty-day idle expiry",
      "production guest redemption persists 180-day absolute expiry",
    ],
    async () => {
      const { invitation } = await guestFixture();
      const guest = await env.createGuestClient({
        displayName: "GuestLife",
        token: invitation.token,
      });
      const digest = cookieDigest(guest.session.cookie);
      const row = (
        await pool.query(
          "SELECT idle_expires_at,absolute_expires_at FROM next_round.sessions WHERE token_hash=$1",
          [digest],
        )
      ).rows[0];
      assert.ok(row, "guest session persisted by production redemption");
      await assertDbInterval(
        row.idle_expires_at,
        "30 days",
        "guest idle session",
      );
      await assertDbInterval(
        row.absolute_expires_at,
        "180 days",
        "guest absolute session",
      );
      const inviteDigest = createHash("sha256")
        .update(invitation.token)
        .digest();
      await pool.query(
        "UPDATE next_round.invitations SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [inviteDigest],
      );
      assert.equal(
        (await request("/api/v1/auth/session", { client: guest })).status,
        200,
        "invitation expiry does not expire an already redeemed guest session",
      );
    },
  );
  await run(
    "H1:guest-invitation-permission-revocation",
    [
      "revoked guest invitation cannot be redeemed",
      "admin permission removal revokes pending invites and blocks further guest invitation issuance",
    ],
    async () => {
      const { matchId, invitation } = await guestFixture();
      const tokenHash = createHash("sha256").update(invitation.token).digest();
      const id = (
        await pool.query(
          "SELECT id FROM next_round.invitations WHERE token_hash=$1",
          [tokenHash],
        )
      ).rows[0].id;
      const revoked = await request(`/api/v1/invitations/${id}`, {
        method: "DELETE",
        body: {},
        client: scenario.creator,
      });
      assert.equal(revoked.status, 204, "issuer revokes pending invitation");
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM next_round.invitations WHERE id=$1",
            [id],
          )
        ).rows[0].status,
        "revoked",
        "permission scenario invite is revoked through production API",
      );
      const rejected = await unauthenticated(
        "/guest-invitations/redeem",
        { token: invitation.token, displayName: "RevokedGuest" },
        ctx.apiB.url,
      );
      assert.equal(
        rejected.status,
        410,
        "revoked invitation returns TOKEN_INVALID",
      );
      const pendingInvite =
        await scenario.creator.createGuestInvitation(matchId);
      const pendingHash = createHash("sha256")
        .update(pendingInvite.token)
        .digest();
      const pendingId = (
        await pool.query(
          "SELECT id FROM next_round.invitations WHERE token_hash=$1",
          [pendingHash],
        )
      ).rows[0].id;
      const permission = await adminPatch(
        `/admin/users/${scenario.creator.session.principalId}`,
        { canInviteGuests: false },
      );
      assert.equal(
        permission.status,
        200,
        "admin PATCH revokes guest invitation permission",
      );
      try {
        assert.equal(
          (
            await pool.query(
              "SELECT status FROM next_round.invitations WHERE id=$1",
              [pendingId],
            )
          ).rows[0].status,
          "revoked",
          "permission change revokes already pending invitations",
        );
        const denied = await request(
          `/api/v1/matches/${matchId}/guest-invitations`,
          {
            method: "POST",
            client: scenario.creator,
            body: { commandId: command() },
          },
        );
        assert.equal(
          denied.status,
          403,
          "removed invitation permission returns FORBIDDEN",
        );
      } finally {
        const restored = await adminPatch(
          `/admin/users/${scenario.creator.session.principalId}`,
          { canInviteGuests: true },
        );
        assert.equal(
          restored.status,
          200,
          "admin PATCH restores guest invitation permission",
        );
      }
    },
  );
  await run(
    "H2:guest-session-idle-and-absolute-expiry",
    [
      "idle expiry rejects otherwise valid guest session",
      "absolute expiry independently rejects otherwise idle-valid guest session",
    ],
    async () => {
      const { invitation: idleInvite } = await guestFixture();
      const { invitation: absoluteInvite } = await guestFixture();
      const idleGuest = await env.createGuestClient({
        displayName: "IdleExpiry",
        token: idleInvite.token,
      });
      const absoluteGuest = await env.createGuestClient({
        displayName: "AbsoluteExpiry",
        token: absoluteInvite.token,
      });
      await pool.query(
        "UPDATE next_round.sessions SET idle_expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [cookieDigest(idleGuest.session.cookie)],
      );
      await pool.query(
        "UPDATE next_round.sessions SET absolute_expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [cookieDigest(absoluteGuest.session.cookie)],
      );
      assert.equal(
        (await request("/api/v1/auth/session", { client: idleGuest })).status,
        401,
        "idle expiration denies guest session",
      );
      assert.equal(
        (await request("/api/v1/auth/session", { client: absoluteGuest }))
          .status,
        401,
        "absolute expiration denies guest session",
      );
    },
  );

  await run(
    "H1:invite-full-finished-and-late-join-outcomes",
    [
      "targeted invite admits the recipient to the lobby",
      "late join is admitted to an active match while capacity remains",
      "eighth-player capacity is enforced by production join endpoint",
      "full active and finished matches deny later joins",
      "finished match denies new guest invitations",
    ],
    async () => {
      const fillers = await Promise.all(
        accounts
          .filter((account) => account.username.startsWith("s3_fill"))
          .map((account) =>
            env.createRegisteredClient({
              username: account.username,
              displayName: account.username,
            }),
          ),
      );
      const lateMatch = await scenario.creator.createMatch(
        "test-counter",
        "group",
        { target: 10, turnSeconds: 60 },
        "instance",
      );
      const peerReceipt = await peer.joinMatch(
        lateMatch.matchId,
        (await scenario.creator.getSnapshot(lateMatch.matchId)).revision,
      );
      await scenario.creator.startMatch(
        lateMatch.matchId,
        peerReceipt.committedRevision,
      );
      const lateReceipt = await fillers[0].joinMatch(
        lateMatch.matchId,
        (await scenario.creator.getSnapshot(lateMatch.matchId)).revision,
      );
      assert.ok(
        lateReceipt.committedRevision > peerReceipt.committedRevision,
        "production supports late join before capacity",
      );

      const filled = await scenario.creator.createMatch(
        "test-counter",
        "group",
        { target: 1, turnSeconds: 60 },
        "instance",
      );
      const members = [scenario.peers[0], ...fillers];
      for (const member of members) {
        const issued = await request(
          `/api/v1/matches/${filled.matchId}/invitations`,
          {
            method: "POST",
            client: scenario.creator,
            body: {
              commandId: command(),
              recipientPrincipalId: member.session.principalId,
            },
          },
        );
        assert.equal(issued.status, 201, "host issues targeted invite");
        const invitation = (await issued.json()).data;
        const snapshot = await scenario.creator.getSnapshot(filled.matchId);
        const accepted = await request(
          `/api/v1/invitations/${invitation.id}/accept`,
          {
            method: "POST",
            client: member,
            body: { commandId: command(), expectedRevision: snapshot.revision },
          },
        );
        assert.equal(
          accepted.status,
          200,
          "targeted invite admits recipient to lobby",
        );
      }
      const beforeStart = await scenario.creator.getSnapshot(filled.matchId);
      const full = await request(`/api/v1/matches/${filled.matchId}/join`, {
        method: "POST",
        client: peer,
        body: { commandId: command(), expectedRevision: beforeStart.revision },
      });
      assert.equal(
        full.status,
        409,
        "eighth-player match returns capacity conflict for ninth join",
      );
      const started = await scenario.creator.startMatch(
        filled.matchId,
        beforeStart.revision,
      );
      const late = await request(`/api/v1/matches/${filled.matchId}/join`, {
        method: "POST",
        client: peer,
        body: {
          commandId: command(),
          expectedRevision: started.committedRevision,
        },
      });
      assert.equal(
        late.status,
        409,
        "full running match refuses late join with conflict",
      );
      const ended = await scenario.creator.act(filled.matchId, {
        type: "add",
        payload: { amount: 1 },
        commandId: command(),
        expectedRevision: started.committedRevision,
      });
      assert.equal(
        (await scenario.creator.getSnapshot(filled.matchId)).phase,
        "finished",
        "production game action finishes the match",
      );
      const finishedJoin = await request(
        `/api/v1/matches/${filled.matchId}/join`,
        {
          method: "POST",
          client: peer,
          body: {
            commandId: command(),
            expectedRevision: ended.committedRevision,
          },
        },
      );
      assert.equal(
        finishedJoin.status,
        409,
        "finished match returns closed conflict",
      );
      const finishedInvite = await request(
        `/api/v1/matches/${filled.matchId}/guest-invitations`,
        {
          method: "POST",
          client: scenario.creator,
          body: { commandId: command() },
        },
      );
      assert.equal(
        finishedInvite.status,
        404,
        "finished match cannot issue guest invitations",
      );
    },
  );

  await run(
    "H2:guest-same-device-resume-and-name-imitation",
    [
      "same guest cookie resumes only its bound match",
      "display-name imitation cannot claim guest principal or access history",
      "guest catalog, administration, invitations, and unrelated match access are denied",
      "fresh invitation to the same match creates distinct identity without transferring old points",
    ],
    async () => {
      const guest = scenario.guest;
      const sessionResponse = await request("/api/v1/auth/session", {
        client: guest,
      });
      assert.equal(sessionResponse.status, 200);
      const session = (await sessionResponse.json()).data;
      assert.equal(session.principal.id, guest.session.principalId);
      assert.equal(session.guestMatchId, scenario.matchId);
      const snapshot = await request(`/api/v1/matches/${scenario.matchId}`, {
        client: guest,
      });
      assert.equal(snapshot.status, 200, "guest can resume bound match");
      const catalog = await request("/api/v1/games", { client: guest });
      assert.equal(
        catalog.status,
        403,
        "guest cannot access the general game catalog",
      );
      const administration = await request("/api/v1/admin/games", {
        client: guest,
      });
      assert.equal(
        administration.status,
        403,
        "guest cannot access administration catalog",
      );
      const inviteAttempt = await request(
        `/api/v1/matches/${scenario.matchId}/guest-invitations`,
        {
          method: "POST",
          client: guest,
          body: { commandId: command() },
        },
      );
      assert.equal(inviteAttempt.status, 403, "guest cannot issue invitations");

      const { matchId: historyMatch, invitation: firstInvite } =
        await guestFixture();
      const oldGuest = await env.createGuestClient({
        displayName: "HistoryGuest",
        token: firstInvite.token,
      });
      const oldPrincipal = oldGuest.session.principalId;
      const oldSnapshot = await oldGuest.getSnapshot(historyMatch);
      const started = await scenario.creator.startMatch(
        historyMatch,
        oldSnapshot.revision,
      );
      const oldMemberId = oldSnapshot.members.find(
        (member) => member.principalId === oldPrincipal,
      )?.id;
      assert.ok(
        oldMemberId,
        "old guest is a match member before its contribution",
      );
      const hostAction = await scenario.creator.act(historyMatch, {
        type: "add",
        payload: { amount: 1 },
        commandId: command(),
        expectedRevision: started.committedRevision,
      });
      const activeSnapshot = await oldGuest.getSnapshot(historyMatch);
      assert.equal(
        activeSnapshot.game.currentActorMemberId,
        oldMemberId,
        "turn rotates to old guest",
      );
      const contribution = await oldGuest.act(historyMatch, {
        type: "add",
        payload: { amount: 1 },
        commandId: command(),
        expectedRevision: hostAction.committedRevision,
      });
      const contributedSnapshot = await oldGuest.getSnapshot(historyMatch);
      assert.equal(
        contributedSnapshot.game.scores[oldMemberId],
        1,
        "old guest contribution is recorded against the old member identity",
      );
      const imitatorInvite =
        await scenario.creator.createGuestInvitation(historyMatch);
      const imitator = await env.createGuestClient({
        displayName: "HistoryGuest",
        token: imitatorInvite.token,
      });
      assert.notEqual(
        imitator.session.principalId,
        oldPrincipal,
        "matching display name never claims existing identity",
      );
      const unrelated = await scenario.creator.createMatch(
        "test-counter",
        "group",
        { target: 10, turnSeconds: 60 },
        "instance",
      );
      const otherMatch = await request(`/api/v1/matches/${unrelated.matchId}`, {
        client: imitator,
      });
      assert.equal(otherMatch.status, 404, "guest cannot access another match");
      const existingHistory = await request(`/api/v1/matches/${historyMatch}`, {
        client: oldGuest,
      });
      assert.equal(existingHistory.status, 200);
      assert.ok(
        contribution.committedRevision > activeSnapshot.revision,
        "old guest contribution was committed before re-invite",
      );
      const secondInvite =
        await scenario.creator.createGuestInvitation(historyMatch);
      const replacement = await env.createGuestClient({
        displayName: "HistoryGuest",
        token: secondInvite.token,
      });
      assert.notEqual(
        replacement.session.principalId,
        oldPrincipal,
        "fresh invitation creates a distinct guest principal",
      );
      const replacementSnapshot = await replacement.getSnapshot(historyMatch);
      const replacementMemberId = replacementSnapshot.members.find(
        (member) => member.principalId === replacement.session.principalId,
      )?.id;
      assert.ok(
        replacementMemberId,
        "fresh guest is admitted to the same match",
      );
      assert.equal(
        contributedSnapshot.game.scores[oldMemberId],
        1,
        "old guest's point remains attached to prior member",
      );
      assert.equal(
        replacementSnapshot.game.scores[replacementMemberId] ?? 0,
        0,
        "new guest identity starts without inheriting the prior guest's points",
      );
      assert.equal(
        replacementSnapshot.game.scores[oldMemberId],
        1,
        "same-match prior contribution remains retained",
      );
      assert.equal(
        (
          await request(`/api/v1/matches/${scenario.matchId}`, {
            client: replacement,
          })
        ).status,
        404,
        "fresh guest identity cannot access the original guest's match",
      );
    },
  );
}
