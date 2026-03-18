type NewPostsBannerProps = {
  /** Number of new posts available. */
  count: number
  /** Called when user clicks to load new posts. */
  onLoad: () => void
}

/**
 * Inline pill button that appears beside the countdown timer
 * when new posts are available. Returns null when count is zero
 * so the layout stays stable.
 */
export function NewPostsBanner({ count, onLoad }: NewPostsBannerProps) {
  if (count <= 0) return null

  return (
    <button
      type="button"
      onClick={onLoad}
      className="cursor-pointer rounded-full bg-blue-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-600"
    >
      {count === 1 ? '1 new post' : `${count} new posts`}
    </button>
  )
}
