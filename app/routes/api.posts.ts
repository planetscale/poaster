import { fetchFeedItems } from '~/db/queries'

/** Number of feed items per page. */
const PAGE_SIZE = 50

/**
 * Resource route — returns the next page of feed items (posts + comments)
 * older than the `before` cursor.
 *
 * GET /api/posts?before=2024-01-01T00:00:00.000Z
 * -> { items: [...], hasMore: true }
 */
export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url)
  const before = url.searchParams.get('before')

  if (!before) {
    return Response.json({ items: [], hasMore: false })
  }

  try {
    const beforeDate = new Date(before)
    const items = await fetchFeedItems('/api/posts', PAGE_SIZE, {
      before: beforeDate,
    })

    return Response.json({
      items,
      hasMore: items.length === PAGE_SIZE,
    })
  } catch (error) {
    console.error('[api/posts] Database error:', error)
    return Response.json(
      { error: 'Database unavailable', items: [], hasMore: false },
      { status: 503 },
    )
  }
}
