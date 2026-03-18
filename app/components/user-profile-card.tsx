import { Link } from 'react-router'

import { UserAvatar } from '~/components/user-avatar'

export type UserProfileCardData = {
  id: number
  name: string
  email: string
  postCount: number
}

type UserProfileCardProps = {
  user: UserProfileCardData
}

/**
 * Compact user profile card for the sidebar.
 * Links to the full user profile page.
 */
export function UserProfileCard({ user }: UserProfileCardProps) {
  return (
    <div className="p-4">
      <Link to={`/users/${user.id}`} className="group flex items-center gap-3">
        <UserAvatar name={user.name} size={48} />
        <div className="min-w-0">
          <span className="block truncate text-sm font-semibold text-zinc-950 group-hover:underline dark:text-white">
            {user.name}
          </span>
          <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
            {user.email}
          </span>
        </div>
      </Link>

      <div className="mt-3 border-t border-zinc-950/5 pt-3 dark:border-white/5">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {user.postCount} {user.postCount === 1 ? 'post' : 'posts'}
        </span>
      </div>
    </div>
  )
}
