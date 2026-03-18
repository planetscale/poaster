import { and, count, gt } from 'drizzle-orm'

import db from '~/db'
import { sqlCommenter } from '~/db/sql-commenter'
import { comments, posts } from '~/db/schema'

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
    const [postResult, commentResult] = await Promise.all([
      sqlCommenter.run(
        { route: '/api/posts/count', query: 'newPostCount' },
        () =>
          db
            .select({ value: count() })
            .from(posts)
            .where(and(gt(posts.createdAt, sinceDate))),
      ),
      sqlCommenter.run(
        { route: '/api/posts/count', query: 'newCommentCount' },
        () =>
          db
            .select({ value: count() })
            .from(comments)
            .where(and(gt(comments.createdAt, sinceDate))),
      ),
    ])

    const total = (postResult[0]?.value ?? 0) + (commentResult[0]?.value ?? 0)

    return Response.json({ count: total })
  } catch (error) {
    console.error('[api/posts/count] Database error:', error)
    return Response.json(
      { error: 'Database unavailable', count: 0 },
      { status: 503 },
    )
  }
}
