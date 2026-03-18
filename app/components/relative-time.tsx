import { memo, useEffect, useState } from 'react'

const MINUTE = 60
const HOUR = 3_600
const DAY = 86_400

/**
 * Returns a human-readable relative time string like "2m ago" or "3h ago".
 * Falls back to a short date for anything older than 7 days.
 */
function formatRelative(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1_000)

  if (seconds < MINUTE) return 'just now'
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`
  if (seconds < DAY * 7) return `${Math.floor(seconds / DAY)}d ago`

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Pick a sensible re-render interval based on age:
 * - < 1 hour: every 60s (so "Xm ago" stays accurate)
 * - < 1 day: every 10 min
 * - older: never (date string won't change)
 */
function intervalForAge(date: Date): number | null {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1_000)
  if (seconds < HOUR) return 60_000
  if (seconds < DAY) return 600_000
  return null
}

type RelativeTimeProps = {
  date: string | Date
  className?: string
}

/**
 * Displays a timestamp as relative text (e.g. "2m ago").
 * Periodically re-renders so the label stays accurate.
 * Rendered as a `<time>` element with the full ISO datetime for accessibility.
 */
export const RelativeTime = memo(function RelativeTime({
  date,
  className,
}: RelativeTimeProps) {
  const d = typeof date === 'string' ? new Date(date) : date

  /** Tick counter forces re-render on each interval. */
  const [, setTick] = useState(0)

  useEffect(() => {
    const ms = intervalForAge(d)
    if (ms === null) return

    const id = setInterval(() => setTick((t) => t + 1), ms)
    return () => clearInterval(id)
  }, [d.getTime()])

  return (
    <time dateTime={d.toISOString()} className={className}>
      {formatRelative(d)}
    </time>
  )
})
