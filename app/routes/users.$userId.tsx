import { desc, eq } from 'drizzle-orm'

import type { Route } from './+types/users.$userId'
import { FeedLayout } from '~/components/feed-layout'
import { PostCard } from '~/components/post-card'
import { TrendingTopics } from '~/components/trending-topics'
import { UserAvatar } from '~/components/user-avatar'
import db from '~/db'
import {
  getTrendingTags,
  postCardRelations,
  toPostCardData,
} from '~/db/queries'
import { sqlCommenter } from '~/db/sql-commenter'
import { posts, users } from '~/db/schema'

export function meta({ data }: Route.MetaArgs) {
  if (!data?.user) {
    return [{ title: 'User not found — Poaster' }]
  }
  return [{ title: `${data.user.name} — Poaster` }]
}

export async function loader({ params }: Route.LoaderArgs) {
  const userId = Number(params.userId)

  const user = await sqlCommenter.run(
    { route: '/users/:userId', query: 'user' },
    () =>
      db.query.users.findFirst({
        where: eq(users.id, userId),
      }),
  )

  if (!user) {
    throw new Response('User not found', { status: 404 })
  }

  const [userPosts, trending] = await Promise.all([
    sqlCommenter.run({ route: '/users/:userId', query: 'userPosts' }, () =>
      db.query.posts.findMany({
        where: eq(posts.userId, userId),
        orderBy: [desc(posts.createdAt)],
        with: postCardRelations,
      }),
    ),
    getTrendingTags('/users/:userId'),
  ])

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
    },
    posts: userPosts.map(toPostCardData),
    trending,
  }
}

/**
 * User profile page — shows the user's avatar, name, email,
 * and a list of their posts with trending topics in the sidebar.
 */
export default function UserProfile({ loaderData }: Route.ComponentProps) {
  const { user, posts, trending } = loaderData

  return (
    <FeedLayout sidebar={<TrendingTopics tags={trending} />}>
      {/* Profile header */}
      <div className="mb-6 flex items-center gap-4">
        <UserAvatar name={user.name} size={64} />
        <div>
          <h1 className="text-lg font-semibold text-zinc-950 dark:text-white">
            {user.name}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {user.email}
          </p>
        </div>
      </div>

      {/* Posts */}
      <h2 className="mb-2 text-sm font-semibold text-zinc-950 dark:text-white">
        Posts ({posts.length})
      </h2>

      {posts.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No posts yet.
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
