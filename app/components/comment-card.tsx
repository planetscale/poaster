import { memo } from 'react'
import { Link } from 'react-router'
import { RelativeTime } from '~/components/relative-time'
import { UserAvatar } from '~/components/user-avatar'

export type CommentCardData = {
  id: number
  body: string
  createdAt: string
  user: {
    id: number
    name: string
  }
}

type CommentCardProps = {
  comment: CommentCardData
}

/**
 * A single comment — avatar, username, body, timestamp.
 */
export const CommentCard = memo(function CommentCard({
  comment,
}: CommentCardProps) {
  return (
    <article className="flex gap-3 border-b border-zinc-950/5 py-3 last:border-0 dark:border-white/5">
      <Link to={`/users/${comment.user.id}`} className="shrink-0">
        <UserAvatar name={comment.user.name} size={32} />
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
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {comment.body}
        </p>
      </div>
    </article>
  )
})
