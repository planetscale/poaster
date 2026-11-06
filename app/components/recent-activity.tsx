import { Link } from 'react-router'

import { RelativeTime } from '~/components/relative-time'
import { UserAvatar } from '~/components/user-avatar'
import type { RecentActivityItem } from '~/db/queries'

const ACTION_LABEL: Record<string, string> = {
  comment: 'commented',
  delete: 'removed this',
  like: 'liked this',
  post: 'posted',
  repost: 'reposted this',
  tag: 'tagged this',
  view: 'viewed this',
}

type RecentActivityProps = {
  items: RecentActivityItem[]
}

/**
 * Recent events on a post: who did what, and when.
 */
export function RecentActivity({ items }: RecentActivityProps) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-zinc-950 dark:text-white">
        Recent activity
      </h2>

      {items.length === 0 ? (
        <p className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No recent activity.
        </p>
      ) : (
        <ul>
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-3 border-b border-zinc-950/5 py-2 last:border-0 dark:border-white/5"
            >
              <Link to={`/users/${item.user.id}`} className="shrink-0">
                <UserAvatar name={item.user.name} size={24} />
              </Link>
              <p className="min-w-0 flex-1 truncate text-sm text-zinc-950 dark:text-white">
                <Link
                  to={`/users/${item.user.id}`}
                  className="font-semibold hover:underline"
                >
                  {item.user.name}
                </Link>{' '}
                <span className="text-zinc-500 dark:text-zinc-400">
                  {ACTION_LABEL[item.action] ?? item.action}
                </span>
              </p>
              <RelativeTime
                date={item.createdAt}
                className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400"
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
