import { and, count, desc, eq, gt, lt } from 'drizzle-orm'

import type { CommentCardData } from '~/components/comment-card'
import type { PostCardData } from '~/components/post-card'
import type { TrendingTag } from '~/components/trending-topics'
import db from '~/db'
import { sqlCommenter } from '~/db/sql-commenter'
import { activity, comments, posts, postTags, tags, users } from '~/db/schema'

// ---------------------------------------------------------------------------
// Feed item — discriminated union for the unified timeline
// ---------------------------------------------------------------------------

/**
 * A single entry in the unified feed timeline.
 *
 * - `'post'`    — a standalone post
 * - `'comment'` — a comment surfaced by recency, shown below its parent post
 */
export type FeedItem =
  | { type: 'post'; data: PostCardData }
  | { type: 'comment'; data: CommentCardData; parentPost: PostCardData }

// ---------------------------------------------------------------------------
// Shared relation shapes for Drizzle relational queries
// ---------------------------------------------------------------------------

/**
 * Shared Drizzle `with` clause for loading posts with the fields
 * needed by `PostCardData`. Use this in `db.query.posts.findMany()`
 * or any relational query that includes posts.
 */
export const postCardRelations = {
  user: {
    columns: { id: true, name: true },
  },
  comments: {
    columns: { id: true },
  },
  postTags: {
    columns: {},
    with: { tag: { columns: { name: true } } },
  },
} as const

/**
 * Drizzle `with` clause for loading comments with the fields needed
 * to render a comment feed item — includes the parent post with full
 * `postCardRelations` so we can display it above the comment.
 */
const commentFeedRelations = {
  user: {
    columns: { id: true, name: true },
  },
  post: {
    with: {
      user: { columns: { id: true, name: true } },
      comments: { columns: { id: true } },
      postTags: { columns: {}, with: { tag: { columns: { name: true } } } },
    },
  },
} as const

// ---------------------------------------------------------------------------
// Row shapes returned by relational queries
// ---------------------------------------------------------------------------

/** Row shape returned by a post query using `postCardRelations`. */
type PostRow = {
  id: number
  body: string
  createdAt: Date
  comments: { id: number }[]
  postTags: { tag: { name: string } }[]
  user: { id: number; name: string }
}

/** Row shape returned by a comment query using `commentFeedRelations`. */
type CommentRow = {
  id: number
  body: string
  createdAt: Date
  user: { id: number; name: string }
  /** May be `null` at runtime if the parent post was deleted (orphan). */
  post: PostRow | null
}

// ---------------------------------------------------------------------------
// Mappers — raw Drizzle rows → serializable shapes for client components
// ---------------------------------------------------------------------------

/**
 * Map a raw Drizzle post row (with relations) to the serializable
 * `PostCardData` shape used by client components.
 */
export function toPostCardData(row: PostRow): PostCardData {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    commentCount: row.comments.length,
    tagCount: row.postTags.length,
    user: row.user,
  }
}

/**
 * Map a raw Drizzle comment row (with nested post) to a `FeedItem`
 * of type `'comment'`. Returns `null` when the parent post is missing
 * (orphaned comment) so callers can filter it out.
 */
function toCommentFeedItem(row: CommentRow): FeedItem | null {
  if (!row.post) return null

  return {
    type: 'comment',
    data: {
      id: row.id,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      user: row.user,
    },
    parentPost: toPostCardData(row.post),
  }
}

// ---------------------------------------------------------------------------
// Feed builders — merge posts + comments into a unified timeline
// ---------------------------------------------------------------------------

/**
 * Build a unified feed from separate post and comment query results.
 *
 * Merges both arrays, sorts by `createdAt` descending, and returns
 * at most `limit` items.
 */
function buildFeedItems(
  postRows: PostRow[],
  commentRows: CommentRow[],
  limit: number,
): FeedItem[] {
  const postItems: (FeedItem & { _sortDate: Date })[] = postRows.map((row) => ({
    type: 'post' as const,
    data: toPostCardData(row),
    _sortDate: row.createdAt,
  }))

  const commentItems: (FeedItem & { _sortDate: Date })[] = commentRows
    .map((row) => {
      const item = toCommentFeedItem(row)
      if (!item) return null
      return { ...item, _sortDate: row.createdAt }
    })
    .filter((item): item is FeedItem & { _sortDate: Date } => item !== null)

  const merged = [...postItems, ...commentItems]
    .sort((a, b) => b._sortDate.getTime() - a._sortDate.getTime())
    .slice(0, limit)

  // Strip internal _sortDate before returning
  return merged.map(({ _sortDate: _, ...item }) => item as FeedItem)
}

// ---------------------------------------------------------------------------
// Query helpers — run the actual DB queries for the feed
// ---------------------------------------------------------------------------

/**
 * Fetch the latest posts and comments as a merged `FeedItem[]`.
 *
 * @param route   - The calling route path for SQLCommenter tagging.
 * @param limit   - Max number of feed items to return.
 * @param before  - Optional cursor: only return items with `createdAt < before`.
 * @param after   - Optional cursor: only return items with `createdAt > after`.
 */
export async function fetchFeedItems(
  route: string,
  limit: number,
  options?: { before?: Date; after?: Date },
): Promise<FeedItem[]> {
  const beforeFilter = options?.before
    ? lt(posts.createdAt, options.before)
    : undefined
  const afterFilter = options?.after
    ? gt(posts.createdAt, options.after)
    : undefined
  const commentBeforeFilter = options?.before
    ? lt(comments.createdAt, options.before)
    : undefined
  const commentAfterFilter = options?.after
    ? gt(comments.createdAt, options.after)
    : undefined

  const [postRows, commentRows] = await Promise.all([
    sqlCommenter.run({ action: 'crud', route, query: 'feedPosts' }, () =>
      db.query.posts.findMany({
        where: beforeFilter ?? afterFilter,
        orderBy: [desc(posts.createdAt)],
        limit,
        with: postCardRelations,
      }),
    ),
    sqlCommenter.run({ action: 'crud', route, query: 'feedComments' }, () =>
      db.query.comments.findMany({
        where: commentBeforeFilter ?? commentAfterFilter,
        orderBy: [desc(comments.createdAt)],
        limit,
        with: commentFeedRelations,
      }),
    ),
  ])

  return buildFeedItems(
    postRows as PostRow[],
    commentRows as CommentRow[],
    limit,
  )
}

// ---------------------------------------------------------------------------
// Recent activity — post detail
// ---------------------------------------------------------------------------

/** One row in the post page's recent-activity list. */
export type RecentActivityItem = {
  id: number
  action: string
  createdAt: string
  user: { id: number; name: string }
}

/** How many events to show. The filter is unindexed, so the scan is the cost. */
const RECENT_ACTIVITY_LIMIT = 20

/**
 * Latest events for a post.
 *
 * Filters `activity` on `target_type` + `target_id`, which have no index.
 * On a seeded table this is a sequential scan that PlanetScale Insights
 * can recommend an index for.
 */
export function fetchRecentPostActivity(
  postId: number,
): Promise<RecentActivityItem[]> {
  return sqlCommenter.run(
    {
      action: 'crud',
      route: '/posts/:postId',
      query: 'recentPostActivity',
    },
    async () => {
      const rows = await db
        .select({
          id: activity.id,
          action: activity.action,
          createdAt: activity.createdAt,
          userId: activity.userId,
          userName: users.name,
        })
        .from(activity)
        .leftJoin(users, eq(activity.userId, users.id))
        .where(
          and(eq(activity.targetType, 'post'), eq(activity.targetId, postId)),
        )
        .orderBy(desc(activity.createdAt))
        .limit(RECENT_ACTIVITY_LIMIT)

      return rows.map((row) => ({
        id: row.id,
        action: row.action,
        createdAt: row.createdAt.toISOString(),
        user: {
          id: row.userId,
          name: row.userName ?? `User ${row.userId}`,
        },
      }))
    },
  )
}

// ---------------------------------------------------------------------------
// Trending tags
// ---------------------------------------------------------------------------

/**
 * Fetch the top 10 trending tags by post count.
 * Shared across every route that renders `<TrendingTopics />`.
 *
 * @param route - The calling route path, used for SQLCommenter tagging.
 */
export function getTrendingTags(route: string): Promise<TrendingTag[]> {
  return sqlCommenter.run(
    { action: 'crud', route, query: 'trendingTags' },
    async () => {
      const rows = await db
        .select({
          name: tags.name,
          postCount: count(postTags.postId),
        })
        .from(tags)
        .innerJoin(postTags, eq(tags.id, postTags.tagId))
        .groupBy(tags.id, tags.name)
        .orderBy(desc(count(postTags.postId)))
        .limit(10)

      return rows.map((row) => ({
        name: row.name,
        postCount: row.postCount,
      }))
    },
  )
}
