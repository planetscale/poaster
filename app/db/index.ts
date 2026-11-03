import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'

import { postgresUrlForNode } from './postgres-url'
import * as schema from './schema'
import { createCommentedPool } from './sql-commenter'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}

/**
 * Rewrite the DATABASE_URL to connect via PgBouncer (port 6432) instead
 * of directly to PostgreSQL (port 5432). PgBouncer multiplexes many
 * application-side connections through fewer real database connections,
 * so bursts of analytics traffic don't exhaust server-side connection
 * slots and starve CRUD.
 *
 * `sslrootcert=system` is removed first. That value tells libpq to use
 * the OS trust store, but node-postgres treats it as a file path.
 */
function toPgBouncerUrl(url: string): string {
  const parsed = new URL(postgresUrlForNode(url))
  parsed.port = '6432'
  return parsed.toString()
}

const pgbouncerUrl = toPgBouncerUrl(process.env.DATABASE_URL)

/** Verify certificates with Node's CA store. */
const ssl = { rejectUnauthorized: true }

/**
 * CRUD pool — used by the feed, polling endpoints, and all fast-path
 * operations. Routed through PgBouncer so that all connections
 * (CRUD + analytics) are multiplexed through a managed number of
 * server-side connections — preventing bursts of analytics traffic
 * from exhausting PostgreSQL's max_connections and starving CRUD.
 */
export const pool = createCommentedPool({
  connectionString: pgbouncerUrl,
  ssl,
  max: 10,
  connectionTimeoutMillis: 5_000,
})

/**
 * Analytics pool — dedicated connections for heavy report queries.
 * Completely isolated from the CRUD pool so that analytics traffic
 * (whether it runs for 20 seconds or gets immediately rejected by
 * Traffic Control) never competes with CRUD for connections.
 *
 * Kept intentionally small (5 connections). When Traffic Control
 * rejects queries they resolve fast and free their connection for
 * the next queued request — so 5 is enough to drain even large
 * bursts without flooding the database with simultaneous connections.
 */
export const analyticsPool = createCommentedPool({
  connectionString: pgbouncerUrl,
  ssl,
  max: 5,
  connectionTimeoutMillis: 30_000,
})

/** Drizzle client with relational query support. */
const db = drizzle({ client: pool, schema })

export default db
