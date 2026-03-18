import { memo } from 'react'
import {
  ArrowPathRoundedSquareIcon,
  ArrowUpTrayIcon,
  BookmarkIcon,
  ChartBarIcon,
  ChatBubbleOvalLeftIcon,
  HeartIcon,
  TagIcon,
} from '@heroicons/react/24/outline'

/**
 * Deterministic fake number from a post ID.
 * Produces a plausible-looking count without needing DB storage.
 */
function fakeCount(postId: number, seed: number): number {
  const hash = ((postId * 2654435761 + seed * 40503) >>> 0) % 10000
  if (hash < 5000) return hash % 80
  if (hash < 8000) return 100 + (hash % 900)
  return 1000 + (hash % 9000)
}

/** Format large numbers with K suffix. */
function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

type PostActionsProps = {
  postId: number
  commentCount: number
  tagCount: number
}

/**
 * Twitter-style action bar: comment, tags, retweet, heart, views, bookmark, share.
 * Comment and tag counts are real; retweet, heart, and views are deterministic fakes.
 */
export const PostActions = memo(function PostActions({
  postId,
  commentCount,
  tagCount,
}: PostActionsProps) {
  const retweets = fakeCount(postId, 1)
  const hearts = fakeCount(postId, 2)
  const views = fakeCount(postId, 3)

  return (
    <div className="-mx-1.5 mt-2 flex items-center justify-between text-zinc-500 dark:text-zinc-400">
      {/* Comment */}
      <ActionButton icon={ChatBubbleOvalLeftIcon} count={commentCount} />

      {/* Tags */}
      <ActionButton icon={TagIcon} count={tagCount} />

      {/* Retweet */}
      <ActionButton icon={ArrowPathRoundedSquareIcon} count={retweets} />

      {/* Heart */}
      <ActionButton icon={HeartIcon} count={hearts} />

      {/* Views */}
      <ActionButton icon={ChartBarIcon} count={views} />

      {/* Bookmark — no count */}
      <ActionButton icon={BookmarkIcon} />

      {/* Share — no count */}
      <ActionButton icon={ArrowUpTrayIcon} />
    </div>
  )
})

type ActionButtonProps = {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  count?: number
}

const ActionButton = memo(function ActionButton({
  icon: Icon,
  count,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      className="group flex cursor-pointer items-center gap-1 rounded-full p-1.5 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
    >
      <Icon className="size-4" />
      {count !== undefined ? (
        <span className="text-xs">{formatCount(count)}</span>
      ) : null}
    </button>
  )
})
