import type { ReactNode } from 'react'

type FeedLayoutProps = {
  /** Main content column (feed, post detail, etc.). */
  children: ReactNode
  /** Sidebar content rendered on the right at `md:` breakpoint. */
  sidebar: ReactNode
}

/**
 * Shared two-column layout used by every page route.
 * Single column on mobile, feed + sticky sidebar on desktop.
 */
export function FeedLayout({ children, sidebar }: FeedLayoutProps) {
  return (
    <div className="mx-auto grid max-w-4xl grid-cols-1 px-4 md:grid-cols-[1fr_280px] md:px-6">
      <div className="min-w-0 py-4 md:py-6 md:pr-6">{children}</div>

      <aside className="hidden border-l border-zinc-200 py-4 pl-6 dark:border-zinc-700 md:block md:py-6">
        <div className="sticky top-6">{sidebar}</div>
      </aside>
    </div>
  )
}
