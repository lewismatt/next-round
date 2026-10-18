// SPDX-License-Identifier: Apache-2.0

import { migrateDatabase } from "./migrate.js";

const connectionString =
  process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "Database migration requires DATABASE_DIRECT_URL or DATABASE_URL.",
  );
  process.exitCode = 1;
} else {
  try {
    await migrateDatabase({ connectionString });
    console.log("Database migration completed.");
  } catch {
    // Driver errors can contain credentials, SQL and stored values. Never log them.
    console.error("Database migration failed.");
    process.exitCode = 1;
  }
}
