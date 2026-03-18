import { useEffect, useRef } from 'react'

/** SVG circle radius and derived circumference. */
const RADIUS = 14
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Duration of one countdown cycle in milliseconds. */
const DURATION_MS = 2_000

type CountdownTimerProps = {
  /** Called when countdown reaches zero. */
  onComplete: () => void
  /** Pixel size of the SVG. Defaults to 36. */
  size?: number
}

/**
 * Circular SVG countdown timer that fills from 0% to 100% over 2 seconds.
 * Calls `onComplete` each time the cycle finishes, then restarts.
 *
 * Uses refs + direct DOM mutation to avoid ~60 re-renders/sec that
 * would occur with `useState` for the progress value.
 */
export function CountdownTimer({ onComplete, size = 36 }: CountdownTimerProps) {
  const circleRef = useRef<SVGCircleElement>(null)
  const startRef = useRef(Date.now())
  const rafRef = useRef<number>(0)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    startRef.current = Date.now()

    function tick() {
      const elapsed = Date.now() - startRef.current
      const pct = Math.min(elapsed / DURATION_MS, 1)

      if (circleRef.current) {
        circleRef.current.style.strokeDashoffset = String(
          CIRCUMFERENCE * (1 - pct),
        )
      }

      if (pct >= 1) {
        onCompleteRef.current()
        startRef.current = Date.now()
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className="shrink-0 -rotate-90"
      aria-label="Countdown timer"
    >
      {/* Background track */}
      <circle
        cx="16"
        cy="16"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        className="text-zinc-200 dark:text-zinc-700"
      />
      {/* Progress arc */}
      <circle
        ref={circleRef}
        cx="16"
        cy="16"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE}
        className="text-blue-500 transition-none"
      />
    </svg>
  )
}
