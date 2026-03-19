import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useRevalidator } from 'react-router'
import { toast } from 'sonner'

import type { Route } from './+types/_index'
import { Switch } from '~/components/switch'
import { CountdownTimer } from '~/components/countdown-timer'
import {
  FeedItemCard,
  feedItemDate,
  feedItemKey,
} from '~/components/feed-item-card'
import { FeedLayout } from '~/components/feed-layout'
import { NewPostsBanner } from '~/components/new-posts-banner'
import { TrendingTopics } from '~/components/trending-topics'
import type { FeedItem } from '~/db/queries'
import { fetchFeedItems, getTrendingTags } from '~/db/queries'

/** Number of feed items to load per page. */
const PAGE_SIZE = 50

/**
 * Client-side fetch timeout. Under normal conditions, the polling
 * endpoint responds in ~100-300ms. When the database is genuinely
 * overloaded by analytics queries (CPU/IO contention), even simple
 * COUNT queries slow down dramatically. 8 seconds is generous enough
 * to survive minor hiccups but short enough to surface real DB
 * degradation within a couple of countdown cycles.
 */
const FETCH_TIMEOUT_MS = 8_000

export function meta() {
  return [
    { title: 'Poaster — Feed' },
    { name: 'description', content: 'Latest posts from the community' },
  ]
}

/**
 * Number of consecutive polling failures before the feed renders the
 * fail-whale. Under heavy DB load, the polling endpoint will return
 * 503 (statement_timeout exceeded) or the fetch will timeout. With
 * a ~2-second countdown cycle, 3 failures = ~6-10 seconds of visible
 * degradation before the full error state appears.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 3

export async function loader() {
  const [items, trending] = await Promise.all([
    fetchFeedItems('/', PAGE_SIZE),
    getTrendingTags('/'),
  ])

  return {
    items,
    trending,
    hasMore: items.length === PAGE_SIZE,
    lastChecked: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Hooks — extracted from the Home component for clarity
// ---------------------------------------------------------------------------

/**
 * Persists auto-mode to localStorage and triggers a revalidation
 * when the user switches it on while new posts are pending.
 */
function useAutoMode(
  revalidator: ReturnType<typeof useRevalidator>,
  setNewPostCount: React.Dispatch<React.SetStateAction<number>>,
) {
  const [autoMode, setAutoMode] = useState(false)

  const autoModeRef = useRef(autoMode)
  autoModeRef.current = autoMode

  /** Ref-backed setter so callers don't need autoMode in deps. */
  const newPostCountRef = useRef(0)
  const lastCheckedRef = useRef<string>('')
  const revalidatorRef = useRef(revalidator)
  revalidatorRef.current = revalidator

  /** Hydrate from localStorage after mount to avoid SSR mismatch. */
  useEffect(() => {
    const stored = localStorage.getItem('autoMode') === 'true'
    if (stored) setAutoMode(true)
  }, [])

  /** Persist changes and revalidate when toggled on with pending posts. */
  useEffect(() => {
    localStorage.setItem('autoMode', String(autoMode))

    if (autoMode && newPostCountRef.current > 0) {
      newPostCountRef.current = 0
      setNewPostCount(0)
      lastCheckedRef.current = new Date().toISOString()
      revalidatorRef.current.revalidate()
    }
  }, [autoMode])

  return {
    autoMode,
    setAutoMode,
    autoModeRef,
    newPostCountRef,
    lastCheckedRef,
  }
}

/**
 * Polls `/api/posts/count` every time the countdown timer fires.
 * In auto-mode, triggers a revalidation; in manual mode, accumulates
 * the count so the banner can display it.
 *
 * Returns `'ok'` on success, `'error'` on failure. The caller uses
 * this to track consecutive failures and escalate to the fail-whale.
 */
function usePolling(
  autoModeRef: React.RefObject<boolean>,
  lastCheckedRef: React.MutableRefObject<string>,
  newPostCountRef: React.MutableRefObject<number>,
  revalidator: ReturnType<typeof useRevalidator>,
  setNewPostCount: React.Dispatch<React.SetStateAction<number>>,
) {
  const revalidatorRef = useRef(revalidator)
  revalidatorRef.current = revalidator

  return useCallback(async (): Promise<'ok' | 'error'> => {
    try {
      const url = `/api/posts/count?since=${encodeURIComponent(lastCheckedRef.current)}`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) {
        toast.error('Failed to check for new posts', {
          id: 'polling-error',
          description: `Server responded with ${res.status}`,
        })
        return 'error'
      }

      const json = (await res.json()) as { count: number }
      if (json.count <= 0) return 'ok'

      lastCheckedRef.current = new Date().toISOString()

      if (autoModeRef.current) {
        revalidatorRef.current.revalidate()
      } else {
        newPostCountRef.current += json.count
        setNewPostCount((prev) => prev + json.count)
      }
      return 'ok'
    } catch (error) {
      toast.error('Unable to check for new posts', {
        id: 'polling-error',
        description:
          error instanceof Error ? error.message : 'Network request failed',
      })
      return 'error'
    }
  }, [autoModeRef, lastCheckedRef, newPostCountRef, setNewPostCount])
}

/**
 * Watches the virtualizer's last visible item and fetches the next
 * page of older items via `/api/posts` when the user scrolls near
 * the bottom.
 */
function useInfiniteScroll(
  allItems: FeedItem[],
  hasMore: boolean,
  setExtraItems: React.Dispatch<React.SetStateAction<FeedItem[]>>,
  setHasMore: React.Dispatch<React.SetStateAction<boolean>>,
  setLoadError: React.Dispatch<React.SetStateAction<string | null>>,
  lastItemIndex: number | undefined,
) {
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  /** Ref keeps allItems fresh inside the callback without re-creating it. */
  const allItemsRef = useRef(allItems)
  allItemsRef.current = allItems

  const loadMore = useCallback(async () => {
    if (!hasMore) return
    setIsLoadingMore(true)
    setLoadError(null)

    try {
      const items = allItemsRef.current
      const oldest = items[items.length - 1]
      if (!oldest) return

      const oldestDate = feedItemDate(oldest)
      const url = `/api/posts?before=${encodeURIComponent(oldestDate)}`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) {
        setLoadError('Failed to load more posts. Try scrolling again.')
        return
      }

      const json = (await res.json()) as {
        items: FeedItem[]
        hasMore: boolean
      }
      setExtraItems((prev) => [...prev, ...json.items])
      setHasMore(json.hasMore)
    } catch {
      setLoadError('Network error. Try scrolling again.')
    } finally {
      setIsLoadingMore(false)
    }
  }, [hasMore, setExtraItems, setHasMore, setLoadError])

  useEffect(() => {
    if (lastItemIndex === undefined) return
    if (
      lastItemIndex >= allItemsRef.current.length - 5 &&
      hasMore &&
      !isLoadingMore
    ) {
      loadMore()
    }
  }, [lastItemIndex, hasMore, isLoadingMore, loadMore])

  return { isLoadingMore }
}

// ---------------------------------------------------------------------------
// Memoized virtual row to avoid re-rendering all visible rows when the
// virtualizer updates positions.
// ---------------------------------------------------------------------------

/** Stagger delay per new item in milliseconds. */
const STAGGER_DELAY_MS = 100

type VirtualRowProps = {
  item: FeedItem
  start: number
  scrollMargin: number
  index: number
  measureElement: (el: Element | null) => void
  /** 0-based stagger index among new items, or -1 if already seen. */
  animationIndex: number
}

const VirtualRow = memo(function VirtualRow({
  item,
  start,
  scrollMargin,
  index,
  measureElement,
  animationIndex,
}: VirtualRowProps) {
  return (
    <div
      ref={measureElement}
      data-index={index}
      className="absolute left-0 top-0 w-full"
      style={{ transform: `translateY(${start - scrollMargin}px)` }}
    >
      <div
        style={
          animationIndex >= 0
            ? {
                animation: 'feed-fade-in 0.3s ease-out both',
                animationDelay: `${animationIndex * STAGGER_DELAY_MS}ms`,
              }
            : undefined
        }
      >
        <FeedItemCard item={item} />
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

/**
 * Homepage feed — virtualized list of latest posts and comments with a
 * 1-second countdown timer that polls for new item counts, and infinite
 * scroll to load older items.
 */
export default function Home({ loaderData }: Route.ComponentProps) {
  const {
    items: initialItems,
    trending: loaderTrending,
    hasMore: initialHasMore,
    lastChecked: initialLastChecked,
  } = loaderData

  // Pin trending tags to the initial load so they don't visually
  // shuffle every time the feed revalidates from polling.
  const trendingRef = useRef(loaderTrending)
  const trending = trendingRef.current

  const revalidator = useRevalidator()
  const [newPostCount, setNewPostCount] = useState(0)

  // Client-side consecutive failure tracking. When the polling endpoint
  // fails enough times in a row, we throw during render to trigger the
  // root ErrorBoundary (fail-whale) instead of silently degrading.
  const consecutiveFailuresRef = useRef(0)
  const [feedUnavailable, setFeedUnavailable] = useState(false)

  const {
    autoMode,
    setAutoMode,
    autoModeRef,
    newPostCountRef,
    lastCheckedRef,
  } = useAutoMode(revalidator, setNewPostCount)

  // Seed lastCheckedRef on mount only. After that, the polling callback
  // and handleLoadNewPosts manage the ref — syncing from loaderData on
  // every render would overwrite the ref during intermediate re-renders
  // caused by revalidator state transitions (idle → loading) before the
  // loader returns new data, breaking auto-mode and manual refresh.
  if (!lastCheckedRef.current) {
    lastCheckedRef.current = initialLastChecked
  }

  // Extra items accumulated via infinite scroll
  const [extraItems, setExtraItems] = useState<FeedItem[]>([])
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Reset extra items when loader data changes (revalidation) via key
  const loaderKey = initialItems.map(feedItemKey).join(',')
  const prevLoaderKey = useRef(loaderKey)
  useEffect(() => {
    if (loaderKey !== prevLoaderKey.current) {
      prevLoaderKey.current = loaderKey
      setExtraItems([])
      setHasMore(initialHasMore)
    }
  }, [loaderKey, initialHasMore])

  const allItems = [...initialItems, ...extraItems]

  // Animation tracking: IDs present at mount don't animate; new IDs do.
  // On each revalidation we promote previously-animated keys into the
  // "seen" set and clear the animation map so the CSS keyframe replays
  // for genuinely new items.
  const seenItemKeysRef = useRef<Set<string>>(
    new Set(initialItems.map(feedItemKey)),
  )
  const animationMapRef = useRef<Map<string, number>>(new Map())
  const prevAnimLoaderKey = useRef(loaderKey)

  if (loaderKey !== prevAnimLoaderKey.current) {
    // Promote old animated keys → seen so they won't re-animate.
    for (const key of animationMapRef.current.keys()) {
      seenItemKeysRef.current.add(key)
    }
    animationMapRef.current = new Map()
    prevAnimLoaderKey.current = loaderKey
  }

  // Eagerly assign stagger indices for every new item in the list.
  const allItemKeys = allItems.map(feedItemKey)
  let nextIdx = animationMapRef.current.size
  for (const key of allItemKeys) {
    if (seenItemKeysRef.current.has(key)) continue
    if (animationMapRef.current.has(key)) continue
    animationMapRef.current.set(key, nextIdx++)
  }

  /** Stable lookup — never assigns, only reads. */
  function getAnimationIndex(item: FeedItem): number {
    return animationMapRef.current.get(feedItemKey(item)) ?? -1
  }

  // Virtualizer
  const listRef = useRef<HTMLDivElement>(null)
  const virtualizer = useWindowVirtualizer({
    count: allItems.length,
    estimateSize: (index) => {
      const item = allItems[index]
      // Comment items are taller — parent post + connecting line + comment
      return item?.type === 'comment' ? 260 : 120
    },
    overscan: 10,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const lastItem = virtualItems[virtualItems.length - 1]

  // Hooks
  const poll = usePolling(
    autoModeRef,
    lastCheckedRef,
    newPostCountRef,
    revalidator,
    setNewPostCount,
  )

  /** Wraps the poll callback to track consecutive failures. */
  const handleCountdownComplete = useCallback(async () => {
    const result = await poll()
    if (result === 'ok') {
      consecutiveFailuresRef.current = 0
    } else {
      consecutiveFailuresRef.current++
      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
        setFeedUnavailable(true)
      }
    }
  }, [poll])

  const { isLoadingMore } = useInfiniteScroll(
    allItems,
    hasMore,
    setExtraItems,
    setHasMore,
    setLoadError,
    lastItem?.index,
  )

  // Throw during render to trigger the root ErrorBoundary (fail-whale).
  // The error message contains "timeout" so isDatabaseError() matches.
  if (feedUnavailable) {
    throw new Error(
      'Feed polling timeout — database overwhelmed by analytics queries',
    )
  }

  /** User clicked the "new posts" banner — revalidate the feed. */
  function handleLoadNewPosts() {
    setNewPostCount(0)
    newPostCountRef.current = 0
    lastCheckedRef.current = new Date().toISOString()
    revalidator.revalidate()
  }

  return (
    <FeedLayout sidebar={<TrendingTopics tags={trending} />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-950 dark:text-white">
          For you
        </h1>
        <div className="flex items-center gap-3">
          <NewPostsBanner count={newPostCount} onLoad={handleLoadNewPosts} />
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Auto
            </span>
            <Switch
              checked={autoMode}
              onChange={setAutoMode}
              color="sky"
              name="autoMode"
            />
          </label>
          <CountdownTimer onComplete={handleCountdownComplete} size={16} />
        </div>
      </div>

      {allItems.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No posts yet. They&apos;ll appear here once created.
        </p>
      ) : (
        <>
          <div
            ref={listRef}
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((virtualRow) => {
              const item = allItems[virtualRow.index]
              return (
                <VirtualRow
                  key={feedItemKey(item)}
                  item={item}
                  start={virtualRow.start}
                  scrollMargin={virtualizer.options.scrollMargin}
                  index={virtualRow.index}
                  measureElement={virtualizer.measureElement}
                  animationIndex={getAnimationIndex(item)}
                />
              )
            })}
          </div>

          {isLoadingMore && (
            <p className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
              Loading more posts...
            </p>
          )}

          {loadError ? (
            <p className="py-4 text-center text-sm text-red-500">{loadError}</p>
          ) : null}

          {!hasMore && allItems.length > 0 ? (
            <p className="py-4 text-center text-sm text-zinc-400 dark:text-zinc-500">
              You&apos;ve reached the end.
            </p>
          ) : null}
        </>
      )}
    </FeedLayout>
  )
}
