import { pool } from '~/db'
import { sqlCommenter } from '~/db/sql-commenter'

/**
 * Statement-level timeout for polling queries (in milliseconds).
 * When the database is overloaded by analytics queries, even simple
 * COUNT queries compete for CPU/IO. This timeout ensures the polling
 * endpoint fails fast with a clear "statement timeout" error from
 * PostgreSQL itself — proving the database is genuinely overwhelmed,
 * not just that the application ran out of pool connections.
 */
const STATEMENT_TIMEOUT_MS = 5_000

/**
 * Resource route — returns the count of new feed items (posts + comments)
 * created after the `since` timestamp. Used by the homepage polling
 * mechanism to detect new activity.
 *
 * GET /api/posts/count?since=2024-01-01T00:00:00.000Z
 * -> { count: 12 }
 */
export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url)
  const since = url.searchParams.get('since')

  if (!since) {
    return Response.json({ count: 0 })
  }

  const sinceDate = new Date(since)

  try {
    const result = await sqlCommenter.run(
      { route: '/api/posts/count', query: 'newPostCount' },
      async () => {
        const client = await pool.connect()
        try {
          // Wrap in a transaction so SET LOCAL is scoped to this
          // request and doesn't leak via PgBouncer's connection reuse.
          await client.query('BEGIN')
          await client.query(
            `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`,
          )

          const [postResult, commentResult] = await Promise.all([
            client.query(
              `SELECT COUNT(*) AS value FROM posts WHERE created_at > $1`,
              [sinceDate],
            ),
            client.query(
              `SELECT COUNT(*) AS value FROM comments WHERE created_at > $1`,
              [sinceDate],
            ),
          ])

          await client.query('COMMIT')

          return {
            posts: parseInt(postResult.rows[0]?.value ?? '0', 10),
            comments: parseInt(commentResult.rows[0]?.value ?? '0', 10),
          }
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {})
          throw err
        } finally {
          client.release()
        }
      },
    )

    const total = result.posts + result.comments

    return Response.json({ count: total })
  } catch (error) {
    console.error('[api/posts/count] Database error:', error)
    return Response.json(
      { error: 'Database unavailable', count: 0 },
      { status: 503 },
    )
  }
}
