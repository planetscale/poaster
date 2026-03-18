import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-request context attached to every SQL query as a trailing comment. */
interface SqlCommenterContext {
  /** Traffic Control class: 'crud' | 'analytics' | 'monitor'. */
  action?: string
  /** Logical query name, e.g. `feedPosts` or `trendingTags`. */
  query?: string
  /** Grouping label for related queries, e.g. `analytics`. */
  queryGroup?: string
  /** Route that triggered the query, e.g. `/api/posts`. */
  route?: string
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage — carries context from route handlers into the pg wrapper
// ---------------------------------------------------------------------------

export const sqlCommenter = new AsyncLocalStorage<SqlCommenterContext>()

// ---------------------------------------------------------------------------
// SQLCommenter formatting (https://google.github.io/sqlcommenter/spec/)
// ---------------------------------------------------------------------------

/**
 * Serialize a context object into a SQLCommenter-spec comment string.
 *
 * Keys are sorted lexicographically. Values are URL-encoded, meta-escaped,
 * and wrapped in single quotes per the spec.
 */
function formatSqlComment(ctx: SqlCommenterContext): string {
  const pairs: string[] = []

  for (const key of Object.keys(ctx).sort()) {
    const value = ctx[key as keyof SqlCommenterContext]
    if (value === undefined || value === '') continue

    const encodedKey = encodeURIComponent(key).replace(/'/g, "\\'")
    const encodedValue = encodeURIComponent(value).replace(/'/g, "\\'")

    pairs.push(`${encodedKey}='${encodedValue}'`)
  }

  if (pairs.length === 0) return ''
  return `/* ${pairs.join(',')} */`
}

// ---------------------------------------------------------------------------
// Commented Pool — wraps pg.Pool so every query gets a trailing SQL comment
// ---------------------------------------------------------------------------

/**
 * Create a `pg.Pool` whose `.query()` calls automatically append a
 * SQLCommenter comment derived from the current `AsyncLocalStorage` context.
 *
 * Drizzle's node-postgres driver calls `pool.query(config, params)` where
 * `config` is either a string or a `{ text: string; ... }` object. We
 * intercept both forms.
 */
/**
 * Patch a `.query()` method so it appends the current SQLCommenter
 * context. Works for both `Pool.query` and `PoolClient.query`.
 */
function patchQuery<T extends { query: (...args: unknown[]) => unknown }>(
  target: T,
): void {
  const original = target.query.bind(target)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target.query = function commentedQuery(...args: [any, ...any[]]) {
    const ctx = sqlCommenter.getStore()
    const comment = ctx ? formatSqlComment(ctx) : ''

    if (comment) {
      const first = args[0]

      if (typeof first === 'string') {
        args[0] = `${first} ${comment}`
      } else if (first && typeof first === 'object' && 'text' in first) {
        args[0] = { ...first, text: `${first.text} ${comment}` }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (original as any)(...args)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

export function createCommentedPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(config)

  // Patch pool.query() — used by Drizzle for normal CRUD operations
  patchQuery(pool)

  return pool
}

/**
 * Acquire a `PoolClient` from the pool with SQLCommenter injection
 * on its `.query()` method. Use this for manual transactions (e.g.
 * analytics queries) instead of calling `pool.connect()` directly.
 *
 * Drizzle uses `pool.query()` (already patched) and never calls
 * `pool.connect()`, so we avoid patching `connect()` globally
 * which would interfere with Drizzle's internals.
 */
export async function getCommentedClient(
  pool: pg.Pool,
): Promise<pg.PoolClient> {
  const client = await pool.connect()
  patchQuery(client)
  return client
}
