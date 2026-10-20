// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import type { TransactionClient } from "./transaction-authority.js";

/** Caller holds the issuer principal lock; all mint paths share these limits. */
export async function chargeInvitationMint(
  client: TransactionClient,
  principalId: string,
): Promise<void> {
  const outstanding = await client.query<{ count: number }>(
    `SELECT (
       (SELECT count(*) FROM next_round.invitations
         WHERE issuer_id=$1 AND status='pending' AND expires_at>clock_timestamp()) +
       (SELECT count(*) FROM next_round.match_links l JOIN next_round.matches m ON m.id=l.match_id
         WHERE l.issued_by=$1 AND l.revoked_at IS NULL AND m.phase <> 'finished')
     )::integer AS count`,
    [principalId],
  );
  if (outstanding.rows[0]!.count >= 50)
    throw new ApiError(
      ERROR_CODES.RATE_LIMITED,
      "Outstanding invitation limit reached.",
      {
        // A backoff hint, not a promise that capacity expires in one minute.
        details: { retryAfterSeconds: 60 },
      },
    );
  const key = createHash("sha256")
    .update(`invitation-mint:${principalId.toLowerCase()}`)
    .digest();
  const budget = await client.query<{ count: number; retry: number }>(
    `SELECT COALESCE(sum(count),0)::integer AS count,
       GREATEST(1,ceil(extract(epoch FROM (min(window_start)+interval '1 hour'-clock_timestamp()))))::integer AS retry
       FROM next_round.rate_buckets WHERE key_hash=$1 AND window_start>clock_timestamp()-interval '1 hour'`,
    [key],
  );
  if (budget.rows[0]!.count >= 20)
    throw new ApiError(
      ERROR_CODES.RATE_LIMITED,
      "Invitation minting limit reached.",
      { details: { retryAfterSeconds: budget.rows[0]!.retry } },
    );
  await client.query(
    `INSERT INTO next_round.rate_buckets(key_hash,window_start,count,expires_at)
    SELECT $1,t,1,t+interval '1 hour' FROM (SELECT clock_timestamp() AS t) stamp
    ON CONFLICT(key_hash,window_start) DO UPDATE SET count=next_round.rate_buckets.count+1`,
    [key],
  );
}
