import { Link } from 'react-router'
import { asc, eq } from 'drizzle-orm'

import type { Route } from './+types/posts.$postId'
import { CommentCard } from '~/components/comment-card'
import type { CommentCardData } from '~/components/comment-card'
import { FeedLayout } from '~/components/feed-layout'
import { PostActions } from '~/components/post-actions'
import { RelativeTime } from '~/components/relative-time'
import { UserAvatar } from '~/components/user-avatar'
import { UserProfileCard } from '~/components/user-profile-card'
import type { UserProfileCardData } from '~/components/user-profile-card'
import db from '~/db'
import { sqlCommenter } from '~/db/sql-commenter'
import { comments, posts } from '~/db/schema'

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData?.post) {
    return [{ title: 'Post not found — Poaster' }]
  }
  return [{ title: `${loaderData.post.user.name} on Poaster` }]
}

export async function loader({ params }: Route.LoaderArgs) {
  const postId = Number(params.postId)

  const post = await sqlCommenter.run(
    { action: 'crud', route: '/posts/:postId', query: 'postDetail' },
    () =>
      db.query.posts.findFirst({
        where: eq(posts.id, postId),
        with: {
          user: true,
          postTags: {
            columns: {},
            with: { tag: { columns: { name: true } } },
          },
        },
      }),
  )

  if (!post) {
    throw new Response('Post not found', { status: 404 })
  }

  const [postComments, userPostCount] = await Promise.all([
    sqlCommenter.run(
      { action: 'crud', route: '/posts/:postId', query: 'postComments' },
      () =>
        db.query.comments.findMany({
          where: eq(comments.postId, postId),
          orderBy: [asc(comments.createdAt)],
          with: {
            user: {
              columns: { id: true, name: true },
            },
          },
        }),
    ),
    sqlCommenter.run(
      { action: 'crud', route: '/posts/:postId', query: 'userPostCount' },
      () => db.$count(posts, eq(posts.userId, post.user.id)),
    ),
  ])

  const commentData: CommentCardData[] = postComments.map((row) => ({
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    user: row.user,
  }))

  const author: UserProfileCardData = {
    id: post.user.id,
    name: post.user.name,
    email: post.user.email,
    postCount: userPostCount,
  }

  return {
    post: {
      id: post.id,
      body: post.body,
      createdAt: post.createdAt.toISOString(),
      tagCount: post.postTags.length,
      user: { id: post.user.id, name: post.user.name },
    },
    author,
    comments: commentData,
  }
}

/**
 * Post detail page — full post content with all comments listed below,
 * and the author's profile card in the sidebar.
 */
export default function PostDetail({ loaderData }: Route.ComponentProps) {
  const { post, author, comments } = loaderData

  return (
    <FeedLayout sidebar={<UserProfileCard user={author} />}>
      {/* Post */}
      <article className="mb-6">
        <div className="mb-4 flex items-center gap-3">
          <Link to={`/users/${post.user.id}`}>
            <UserAvatar name={post.user.name} size={48} />
          </Link>
          <div>
            <Link
              to={`/users/${post.user.id}`}
              className="text-sm font-semibold text-zinc-950 hover:underline dark:text-white"
            >
              {post.user.name}
            </Link>
            <RelativeTime
              date={post.createdAt}
              className="block text-xs text-zinc-500 dark:text-zinc-400"
            />
          </div>
        </div>

        <p className="text-base leading-snug text-zinc-950 dark:text-zinc-100">
          {post.body}
        </p>

        <PostActions
          postId={post.id}
          commentCount={comments.length}
          tagCount={post.tagCount}
        />
      </article>

      {/* Comments */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-950 dark:text-white">
          Comments ({comments.length})
        </h2>

        {comments.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No comments yet.
          </p>
        ) : (
          <div>
            {comments.map((comment) => (
              <CommentCard key={comment.id} comment={comment} />
            ))}
          </div>
        )}
      </section>
    </FeedLayout>
  )
}
