import { eq } from 'drizzle-orm'

import type { Route } from './+types/tags.$tagName'
import { FeedLayout } from '~/components/feed-layout'
import { PostCard } from '~/components/post-card'
import { TrendingTopics } from '~/components/trending-topics'
import db from '~/db'
import { getTrendingTags, toPostCardData } from '~/db/queries'
import { sqlCommenter } from '~/db/sql-commenter'
import { tags } from '~/db/schema'

export function meta({ data }: Route.MetaArgs) {
  if (!data?.tag) {
    return [{ title: 'Tag not found — Poaster' }]
  }
  return [{ title: `#${data.tag.name} — Poaster` }]
}

export async function loader({ params }: Route.LoaderArgs) {
  const [tag, trending] = await Promise.all([
    sqlCommenter.run({ route: '/tags/:tagName', query: 'tagWithPosts' }, () =>
      db.query.tags.findFirst({
        where: eq(tags.name, params.tagName),
        with: {
          postTags: {
            with: {
              post: {
                with: {
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
                },
              },
            },
          },
        },
      }),
    ),
    getTrendingTags('/tags/:tagName'),
  ])

  if (!tag) {
    throw new Response('Tag not found', { status: 404 })
  }

  /** Sort posts newest-first after the relational query. */
  const sortedPosts = tag.postTags
    .map((pt) => pt.post)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )

  return {
    tag: { name: tag.name },
    posts: sortedPosts.map(toPostCardData),
    trending,
  }
}

/**
 * Tag page — shows all posts tagged with a given tag name,
 * with the trending sidebar highlighting the active tag.
 */
export default function TagPage({ loaderData }: Route.ComponentProps) {
  const { tag, posts, trending } = loaderData

  return (
    <FeedLayout
      sidebar={<TrendingTopics tags={trending} activeTag={tag.name} />}
    >
      <h1 className="mb-4 text-lg font-semibold text-zinc-950 dark:text-white">
        #{tag.name}
      </h1>

      {posts.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No posts with this tag yet.
        </p>
      ) : (
        <div>
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}
    </FeedLayout>
  )
}
