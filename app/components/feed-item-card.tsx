import { memo } from 'react'
import { Link } from 'react-router'

import { PostActions } from '~/components/post-actions'
import { PostCard } from '~/components/post-card'
import { RelativeTime } from '~/components/relative-time'
import { UserAvatar } from '~/components/user-avatar'
import type { FeedItem } from '~/db/queries'
import { getPostImageUrl, shouldShowImage } from '~/lib/post-image'

type FeedItemCardProps = {
  item: FeedItem
}

/**
 * Renders a single feed timeline entry.
 *
 * - `'post'`    — delegates to `<PostCard />`
 * - `'comment'` — renders the parent post with a 1px vertical line
 *                  from its avatar down to the reply, followed by a
 *                  "Replying to" label and the comment in post-style layout
 */
export const FeedItemCard = memo(function FeedItemCard({
  item,
}: FeedItemCardProps) {
  if (item.type === 'post') {
    return <PostCard post={item.data} />
  }

  const { parentPost, data: comment } = item

  return (
    <article className="border-b border-zinc-950/5 px-1 dark:border-white/5">
      {/* ── Parent post ── */}
      <div className="flex gap-3 pt-4">
        {/* Avatar column — contains avatar + vertical line below it */}
        <div className="flex shrink-0 flex-col items-center">
          <Link to={`/users/${parentPost.user.id}`} className="shrink-0">
            <UserAvatar name={parentPost.user.name} size={40} />
          </Link>
          {/* Vertical connecting line from avatar to reply */}
          <div className="mt-1 min-h-4 flex-1 w-px bg-zinc-300 dark:bg-zinc-600" />
        </div>

        {/* Post content */}
        <div className="min-w-0 flex-1 pb-2">
          <div className="flex items-center gap-2">
            <Link
              to={`/users/${parentPost.user.id}`}
              className="truncate text-sm font-semibold text-zinc-950 hover:underline dark:text-white"
            >
              {parentPost.user.name}
            </Link>
            <RelativeTime
              date={parentPost.createdAt}
              className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400"
            />
          </div>

          <Link to={`/posts/${parentPost.id}`} className="group block">
            <p className="mt-0.5 text-base leading-snug text-zinc-950 dark:text-zinc-100">
              {parentPost.body}
            </p>
            {shouldShowImage(parentPost.body) && (
              <img
                src={getPostImageUrl(parentPost.id)}
                alt=""
                className="mt-2 aspect-[2/1] w-full rounded-xl object-cover"
                loading="lazy"
              />
            )}
          </Link>

          <PostActions
            postId={parentPost.id}
            commentCount={parentPost.commentCount}
            tagCount={parentPost.tagCount}
          />
        </div>
      </div>

      {/* ── "Replying to" label — line continues through this row ── */}
      <div className="flex gap-3">
        <div className="flex w-10 shrink-0 justify-center">
          <div className="w-px bg-zinc-300 dark:bg-zinc-600" />
        </div>
        <div className="min-w-0 flex-1 py-2">
          <Link
            to={`/users/${parentPost.user.id}`}
            className="text-xs text-zinc-400 hover:underline dark:text-zinc-500"
          >
            Replying to{' '}
            <span className="font-medium text-sky-500">
              {parentPost.user.name}
            </span>
          </Link>
        </div>
      </div>

      {/* ── Reply (same design as a post) ── */}
      <div className="flex gap-3 pb-4">
        <Link to={`/users/${comment.user.id}`} className="shrink-0">
          <UserAvatar name={comment.user.name} size={40} />
        </Link>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              to={`/users/${comment.user.id}`}
              className="truncate text-sm font-semibold text-zinc-950 hover:underline dark:text-white"
            >
              {comment.user.name}
            </Link>
            <RelativeTime
              date={comment.createdAt}
              className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400"
            />
          </div>
          <p className="mt-0.5 text-base leading-snug text-zinc-950 dark:text-zinc-100">
            {comment.body}
          </p>

          <PostActions postId={comment.id} commentCount={0} tagCount={0} />
        </div>
      </div>
    </article>
  )
})

/**
 * Unique key for a feed item — prevents React key collisions between
 * posts and comments that could share the same numeric ID.
 */
export function feedItemKey(item: FeedItem): string {
  return item.type === 'post'
    ? `post-${item.data.id}`
    : `comment-${item.data.id}`
}

/**
 * The `createdAt` value for a feed item — used for cursor pagination
 * and sorting. For comments, this is the comment's own timestamp
 * (which determines its position in the timeline).
 */
export function feedItemDate(item: FeedItem): string {
  return item.data.createdAt
}
