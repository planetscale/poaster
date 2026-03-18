import { Link } from 'react-router'

export type TrendingTag = {
  name: string
  postCount: number
}

type TrendingTopicsProps = {
  tags: TrendingTag[]
  /** When set, the matching tag is visually highlighted. */
  activeTag?: string
}

/**
 * Sidebar panel showing the most-used tags across all posts,
 * ranked by post count. Each tag links to `/tags/:tagName`.
 */
export function TrendingTopics({ tags, activeTag }: TrendingTopicsProps) {
  if (tags.length === 0) return null

  return (
    <div className="p-4">
      <h2 className="mb-3 text-base font-semibold text-zinc-950 dark:text-white">
        Trending
      </h2>

      <ul className="space-y-3">
        {tags.map((tag) => {
          const isActive = tag.name === activeTag
          return (
            <li key={tag.name}>
              <Link
                to={`/tags/${tag.name}`}
                className={`group block rounded-lg px-2 py-1.5 -mx-2 transition-colors ${
                  isActive
                    ? 'bg-zinc-200/60 dark:bg-zinc-800'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/50'
                }`}
              >
                <span
                  className={`text-sm font-medium group-hover:underline ${
                    isActive
                      ? 'text-blue-600 dark:text-blue-400'
                      : 'text-zinc-950 dark:text-white'
                  }`}
                >
                  #{tag.name}
                </span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                  {tag.postCount} {tag.postCount === 1 ? 'post' : 'posts'}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
