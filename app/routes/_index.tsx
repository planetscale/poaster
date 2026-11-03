import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useRevalidator } from 'react-router'
import { toast } from 'sonner'

import type { Route } from './+types/_index'
import { CountdownTimer } from '~/components/countdown-timer'
import {
  FeedItemCard,
  feedItemDate,
  feedItemKey,
} from '~/components/feed-item-card'
import { FeedLayout } from '~/components/feed-layout'
import { NewPostsBanner } from '~/components/new-posts-banner'
import { Switch } from '~/components/switch'
import { TrendingTopics } from '~/components/trending-topics'
import type { FeedItem } from '~/db/queries'
import { fetchFeedItems, getTrendingTags } from '~/db/queries'

/** Number of feed items to load per page. */
const PAGE_SIZE = 50

/**
 * Client-side fetch timeout. Slightly longer than the pool's
 * `connectionTimeoutMillis` (2s) so the server has time to return
 * a proper 503, but short enough that stalled requests don't pile
 * up across countdown cycles.
 */
const FETCH_TIMEOUT_MS = 3_000

export function meta() {
  return [
    { title: 'Poaster — Feed' },
    { name: 'description', content: 'Latest posts from the community' },
  ]
}

/**
 * Number of consecutive polling failures before the feed renders the
 * fail-whale. With a 2-second countdown cycle and a ~3-second pool
 * timeout, this gives roughly 2 visible error toasts before the
 * full error state appears.
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
  initialLastChecked: string,
) {
  const [autoMode, setAutoMode] = useState(false)

  const autoModeRef = useRef(autoMode)
  const newPostCountRef = useRef(0)
  const lastCheckedRef = useRef(initialLastChecked)
  const revalidatorRef = useRef(revalidator)

  useEffect(() => {
    autoModeRef.current = autoMode
  }, [autoMode])

  useEffect(() => {
    revalidatorRef.current = revalidator
  }, [revalidator])

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
  }, [autoMode, setNewPostCount])

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
  lastCheckedRef: React.RefObject<string | null>,
  newPostCountRef: React.RefObject<number>,
  revalidator: ReturnType<typeof useRevalidator>,
  setNewPostCount: React.Dispatch<React.SetStateAction<number>>,
) {
  const revalidatorRef = useRef(revalidator)

  useEffect(() => {
    revalidatorRef.current = revalidator
  }, [revalidator])

  return useCallback(async (): Promise<'ok' | 'error'> => {
    try {
      const since = lastCheckedRef.current ?? ''
      const url = `/api/posts/count?since=${encodeURIComponent(since)}`
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
 * Stagger indices for items that appeared after the first paint.
 * Keys that already animated are promoted into the seen set when the
 * loader data changes, so a refresh does not replay their fade-in.
 */
function useFeedAnimation(items: FeedItem[], loaderKey: string) {
  const animatedKeysRef = useRef<Set<string> | null>(null)
  if (animatedKeysRef.current === null) {
    animatedKeysRef.current = new Set()
  }

  const [seenKeys, setSeenKeys] = useState(
    () => new Set(items.map(feedItemKey)),
  )
  const [seenLoaderKey, setSeenLoaderKey] = useState(loaderKey)

  if (loaderKey !== seenLoaderKey) {
    const nextSeen = new Set(seenKeys)
    const animated = animatedKeysRef.current
    if (animated) {
      for (const key of animated) nextSeen.add(key)
    }
    setSeenLoaderKey(loaderKey)
    setSeenKeys(nextSeen)
  }

  const seen = loaderKey === seenLoaderKey ? seenKeys : undefined
  const indexByKey = new Map<string, number>()
  if (seen) {
    let nextIndex = 0
    for (const item of items) {
      const key = feedItemKey(item)
      if (seen.has(key) || indexByKey.has(key)) continue
      indexByKey.set(key, nextIndex)
      nextIndex += 1
    }
  }

  const signature = [...indexByKey.keys()].join('\0')
  useEffect(() => {
    const animated = animatedKeysRef.current
    if (!animated) return
    animated.clear()
    if (signature.length === 0) return
    for (const key of signature.split('\0')) animated.add(key)
  }, [signature])

  return indexByKey
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
        className={animationIndex >= 0 ? 'feed-item-enter' : undefined}
        style={
          animationIndex >= 0
            ? { animationDelay: `${animationIndex * STAGGER_DELAY_MS}ms` }
            : undefined
        }
      >
        <FeedItemCard item={item} />
      </div>
    </div>
  )
})

type FeedToolbarProps = {
  newPostCount: number
  onLoadNewPosts: () => void
  autoMode: boolean
  onAutoModeChange: (checked: boolean) => void
  onCountdownComplete: () => void
}

function FeedToolbar({
  newPostCount,
  onLoadNewPosts,
  autoMode,
  onAutoModeChange,
  onCountdownComplete,
}: FeedToolbarProps) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h1 className="text-lg font-semibold text-zinc-950 dark:text-white">
        For you
      </h1>
      <div className="flex items-center gap-3">
        <NewPostsBanner count={newPostCount} onLoad={onLoadNewPosts} />
        <label className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Auto</span>
          <Switch
            checked={autoMode}
            onChange={onAutoModeChange}
            color="sky"
            name="autoMode"
          />
        </label>
        <CountdownTimer onComplete={onCountdownComplete} size={16} />
      </div>
    </div>
  )
}

type FeedStreamProps = {
  initialItems: FeedItem[]
  initialHasMore: boolean
  loaderKey: string
}

/**
 * Virtualized feed plus infinite scroll. Pagination state resets when
 * `loaderKey` changes so a revalidation drops client-appended pages.
 */
function FeedStream({
  initialItems,
  initialHasMore,
  loaderKey,
}: FeedStreamProps) {
  const [extraItems, setExtraItems] = useState<FeedItem[]>([])
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pageKey, setPageKey] = useState(loaderKey)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  if (loaderKey !== pageKey) {
    setPageKey(loaderKey)
    setExtraItems((current) => (current.length === 0 ? current : []))
    setHasMore(initialHasMore)
    setLoadError(null)
  }

  const visibleExtra = loaderKey === pageKey ? extraItems : []
  const visibleHasMore = loaderKey === pageKey ? hasMore : initialHasMore
  const allItems = [...initialItems, ...visibleExtra]
  const animationIndexByKey = useFeedAnimation(allItems, loaderKey)

  const listRef = useRef<HTMLDivElement>(null)
  const allItemsRef = useRef<FeedItem[] | null>(null)

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
  const lastItemIndex = virtualItems[virtualItems.length - 1]?.index

  useEffect(() => {
    allItemsRef.current = allItems
  })

  const loadMore = useCallback(async () => {
    if (!visibleHasMore) return
    setIsLoadingMore(true)
    setLoadError(null)

    try {
      const items = allItemsRef.current ?? []
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
  }, [visibleHasMore])

  useEffect(() => {
    if (lastItemIndex === undefined) return
    const itemCount = allItemsRef.current?.length ?? 0
    if (lastItemIndex >= itemCount - 5 && visibleHasMore && !isLoadingMore) {
      void loadMore()
    }
  }, [lastItemIndex, visibleHasMore, isLoadingMore, loadMore])

  if (allItems.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
        No posts yet. They&apos;ll appear here once created.
      </p>
    )
  }

  return (
    <FeedVirtualList
      listRef={listRef}
      virtualizer={virtualizer}
      virtualItems={virtualItems}
      allItems={allItems}
      animationIndexByKey={animationIndexByKey}
      isLoadingMore={isLoadingMore}
      loadError={loadError}
      hasMore={visibleHasMore}
    />
  )
}

type FeedVirtualListProps = {
  listRef: React.RefObject<HTMLDivElement | null>
  virtualizer: ReturnType<typeof useWindowVirtualizer>
  virtualItems: ReturnType<
    ReturnType<typeof useWindowVirtualizer>['getVirtualItems']
  >
  allItems: FeedItem[]
  animationIndexByKey: Map<string, number>
  isLoadingMore: boolean
  loadError: string | null
  hasMore: boolean
}

function FeedVirtualList({
  listRef,
  virtualizer,
  virtualItems,
  allItems,
  animationIndexByKey,
  isLoadingMore,
  loadError,
  hasMore,
}: FeedVirtualListProps) {
  return (
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
              animationIndex={animationIndexByKey.get(feedItemKey(item)) ?? -1}
            />
          )
        })}
      </div>

      {isLoadingMore ? (
        <p className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
          Loading more posts...
        </p>
      ) : null}

      {loadError ? (
        <p className="py-4 text-center text-sm text-red-500">{loadError}</p>
      ) : null}

      {!hasMore && allItems.length > 0 ? (
        <p className="py-4 text-center text-sm text-zinc-400 dark:text-zinc-500">
          You&apos;ve reached the end.
        </p>
      ) : null}
    </>
  )
}

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
  } = useAutoMode(revalidator, setNewPostCount, initialLastChecked)

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
      return
    }
    consecutiveFailuresRef.current += 1
    if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
      setFeedUnavailable(true)
    }
  }, [poll])

  /** User clicked the "new posts" banner — revalidate the feed. */
  function handleLoadNewPosts() {
    setNewPostCount(0)
    newPostCountRef.current = 0
    lastCheckedRef.current = new Date().toISOString()
    revalidator.revalidate()
  }

  if (feedUnavailable) {
    throw new Error('Feed polling timeout — database connections exhausted')
  }

  const loaderKey = initialItems.map(feedItemKey).join(',')

  return (
    <FeedLayout sidebar={<TrendingTopics tags={trending} />}>
      <FeedToolbar
        newPostCount={newPostCount}
        onLoadNewPosts={handleLoadNewPosts}
        autoMode={autoMode}
        onAutoModeChange={setAutoMode}
        onCountdownComplete={handleCountdownComplete}
      />
      <FeedStream
        initialItems={initialItems}
        initialHasMore={initialHasMore}
        loaderKey={loaderKey}
      />
    </FeedLayout>
  )
}
