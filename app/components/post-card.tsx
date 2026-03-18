import { memo } from 'react'
import { Link } from 'react-router'

import { PostActions } from '~/components/post-actions'
import { RelativeTime } from '~/components/relative-time'
import { UserAvatar } from '~/components/user-avatar'
import { getPostImageUrl, shouldShowImage } from '~/lib/post-image'

export type PostCardData = {
  id: number
  body: string
  createdAt: string
  commentCount: number
  tagCount: number
  user: {
    id: number
    name: string
  }
}

type PostCardProps = {
  post: PostCardData
}

/**
 * A single post in the feed — avatar, username, body,
 * timestamp, and a Twitter-style action bar.
 */
export const PostCard = memo(function PostCard({ post }: PostCardProps) {
  return (
    <article className="flex gap-3 border-b border-zinc-950/5 px-1 py-4 dark:border-white/5">
      <Link to={`/users/${post.user.id}`} className="shrink-0">
        <UserAvatar name={post.user.name} size={40} />
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            to={`/users/${post.user.id}`}
            className="truncate text-sm font-semibold text-zinc-950 hover:underline dark:text-white"
          >
            {post.user.name}
          </Link>
          <RelativeTime
            date={post.createdAt}
            className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400"
          />
        </div>

        <Link to={`/posts/${post.id}`} className="group block">
          <p className="mt-0.5 text-base leading-snug text-zinc-950 dark:text-zinc-100">
            {post.body}
          </p>
          {shouldShowImage(post.body) && (
            <img
              src={getPostImageUrl(post.id)}
              alt=""
              className="mt-2 aspect-[2/1] w-full rounded-xl bg-checkerboard object-cover"
              loading="lazy"
            />
          )}
        </Link>

        <PostActions
          postId={post.id}
          commentCount={post.commentCount}
          tagCount={post.tagCount}
        />
      </div>
    </article>
  )
})
