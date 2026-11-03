import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'

import { postgresUrlForNode } from './postgres-url'
import * as schema from './schema'
import { createCommentedPool } from './sql-commenter'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}

/** pg Pool with automatic SQLCommenter tag injection. */
export const pool = createCommentedPool({
  connectionString: postgresUrlForNode(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: true },
  /**
   * Fail fast when all connections are held by long-running analytics
   * queries. Without this, pending requests queue indefinitely inside
   * pg-pool and the app silently hangs instead of surfacing errors.
   *
   * 2s is enough headroom for normal query latency to a remote
   * PlanetScale DB (~100-300ms) while still failing quickly under
   * pool contention from analytics.
   */
  connectionTimeoutMillis: 2_000,
})

/** Drizzle client with relational query support. */
const db = drizzle({ client: pool, schema })

export default db
