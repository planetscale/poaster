import { useCallback, useEffect, useRef, useState } from 'react'
import { data, useFetcher, useFetchers } from 'react-router'
import { toast } from 'sonner'

import type { Route } from './+types/admin'
import {
  runEngagementAnalytics,
  runRetentionAnalysis,
  runTrendingAnalytics,
  runUserActivityReport,
  seedActivityData,
} from '~/db/analytics'
import type { AnalyticsResult } from '~/db/analytics'
import { Badge } from '~/components/badge'
import { Button } from '~/components/button'
import { Divider } from '~/components/divider'
import { Heading, Subheading } from '~/components/heading'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/table'
import { Text } from '~/components/text'

// ---------------------------------------------------------------------------
// Report metadata — drives the UI cards
// ---------------------------------------------------------------------------

const REPORTS = [
  {
    id: 'engagement',
    name: 'Engagement Analytics',
    badge: '~12s',
    color: 'purple' as const,
  },
  {
    id: 'trending',
    name: 'Trending & Rolling Windows',
    badge: '~16-19s',
    color: 'blue' as const,
  },
  {
    id: 'userActivity',
    name: 'User Activity Report',
    badge: '~15-18s',
    color: 'amber' as const,
  },
  {
    id: 'retention',
    name: 'Retention Analysis',
    badge: '~19-25s',
    color: 'red' as const,
  },
] as const

type ReportId = (typeof REPORTS)[number]['id']

// ---------------------------------------------------------------------------
// Fetcher key prefix — used to identify report fetchers in useFetchers()
// ---------------------------------------------------------------------------

const REPORT_KEY_PREFIX = 'report:'

/** Build a unique fetcher key for a report submission. */
function makeReportKey(reportId: string): string {
  return `${REPORT_KEY_PREFIX}${reportId}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Extract the report ID from a fetcher key. */
function getReportIdFromKey(key: string): string | null {
  if (!key.startsWith(REPORT_KEY_PREFIX)) return null
  return key.slice(REPORT_KEY_PREFIX.length).split(':')[0]
}

// ---------------------------------------------------------------------------
// Action — handles form submissions (seed + report runs)
// ---------------------------------------------------------------------------

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData()
  const intent = formData.get('intent') as string

  if (intent === 'seed') {
    try {
      const result = await seedActivityData()
      return data({
        type: 'seed' as const,
        rowCount: result.rowCount,
        durationMs: result.durationMs,
      })
    } catch (err) {
      return data({
        type: 'error' as const,
        intent,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const runners: Record<ReportId, () => Promise<AnalyticsResult>> = {
    engagement: runEngagementAnalytics,
    trending: runTrendingAnalytics,
    userActivity: runUserActivityReport,
    retention: runRetentionAnalysis,
  }

  const runner = runners[intent as ReportId]
  if (!runner) {
    return data({
      type: 'error' as const,
      intent,
      message: `Unknown intent: ${intent}`,
    })
  }

  try {
    const result = await runner()
    return data({ type: 'report' as const, ...result })
  } catch (err) {
    return data({
      type: 'error' as const,
      intent,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function AdminDashboard() {
  const allFetchers = useFetchers()

  const activeCount = allFetchers.filter(
    (f) => f.key.startsWith(REPORT_KEY_PREFIX) && f.state !== 'idle',
  ).length

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-4 lg:p-6">
      <Heading className="whitespace-nowrap">Admin Dashboard</Heading>

      <div className="flex items-center justify-between gap-4">
        <Subheading level={2} className="whitespace-nowrap">
          Reports
        </Subheading>
        <div className="flex items-center gap-3">
          {activeCount > 0 && <Badge color="red">{activeCount} running</Badge>}
          <FireAllButton />
        </div>
      </div>

      <div className="space-y-6">
        {REPORTS.map((report) => (
          <ReportCard key={report.id} report={report} />
        ))}
      </div>

      <Divider />

      <SeedSection />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fire All button — submits all 4 reports concurrently
// ---------------------------------------------------------------------------

function FireAllButton() {
  const [keys, setKeys] = useState<string[]>([])

  return (
    <>
      {/* Hidden fetcher forms for each concurrent submission */}
      {keys.map((key) => {
        const reportId = getReportIdFromKey(key)
        return (
          <HiddenReportFetcher key={key} fetcherKey={key} intent={reportId!} />
        )
      })}
      <Button
        color="red"
        onClick={() => {
          const newKeys = REPORTS.flatMap((r) =>
            Array.from({ length: 3 }, () => makeReportKey(r.id)),
          )
          setKeys((prev) => [...prev, ...newKeys])
        }}
      >
        Run All Reports
      </Button>
    </>
  )
}

/**
 * Mounts a useFetcher with a given key and immediately submits.
 * Unmounts after completion to avoid leaking fetchers.
 */
function HiddenReportFetcher({
  fetcherKey,
  intent,
}: {
  fetcherKey: string
  intent: string
}) {
  const fetcher = useFetcher<typeof action>({ key: fetcherKey })
  const submitted = useRef(false)

  useEffect(() => {
    if (!submitted.current) {
      submitted.current = true
      fetcher.submit({ intent }, { method: 'post' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}

// ---------------------------------------------------------------------------
// Seed section
// ---------------------------------------------------------------------------

function SeedSection() {
  const fetcher = useFetcher<typeof action>()
  const isSeeding = fetcher.state !== 'idle'
  const result =
    fetcher.data && 'type' in fetcher.data && fetcher.data.type === 'seed'
      ? fetcher.data
      : null
  const error =
    fetcher.data &&
    'type' in fetcher.data &&
    fetcher.data.type === 'error' &&
    fetcher.data.intent === 'seed'
      ? fetcher.data
      : null

  const prevState = useRef(fetcher.state)
  useEffect(() => {
    if (prevState.current !== 'idle' && fetcher.state === 'idle') {
      if (error) {
        toast.error('Seed failed', { description: error.message })
      } else if (result) {
        toast.success('Seed complete', {
          description: `${result.rowCount.toLocaleString()} rows in ${(result.durationMs / 1000).toFixed(1)}s`,
        })
      }
    }
    prevState.current = fetcher.state
  }, [fetcher.state, error, result])

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
      <div className="flex items-start justify-between gap-4">
        <Subheading level={3} className="whitespace-nowrap">
          Seed Analytics Data
        </Subheading>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="seed" />
          <Button type="submit" color="emerald" disabled={isSeeding}>
            {isSeeding ? 'Seeding...' : 'Seed Data'}
          </Button>
        </fetcher.Form>
      </div>
      {result && (
        <div className="mt-3">
          <Badge color="emerald">
            {result.rowCount.toLocaleString()} rows seeded in{' '}
            {(result.durationMs / 1000).toFixed(1)}s
          </Badge>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Report card — supports concurrent submissions via keyed fetchers
// ---------------------------------------------------------------------------

function ReportCard({ report }: { report: (typeof REPORTS)[number] }) {
  const allFetchers = useFetchers()
  const [keys, setKeys] = useState<string[]>([])

  // Find all fetchers belonging to this report (from both card and Fire All)
  const myFetchers = allFetchers.filter(
    (f) => getReportIdFromKey(f.key) === report.id,
  )
  const runningCount = myFetchers.filter((f) => f.state !== 'idle').length

  // Latest completed result
  const latestCompleted = [...myFetchers]
    .reverse()
    .find(
      (f) =>
        f.state === 'idle' &&
        f.data &&
        typeof f.data === 'object' &&
        'type' in f.data &&
        f.data.type === 'report',
    )

  const resultData = latestCompleted?.data as
    | (AnalyticsResult & { type: 'report' })
    | undefined

  // Toast tracking — fire once per completed fetcher
  const toastedKeys = useRef(new Set<string>())
  const prevLoadingKeys = useRef(new Set<string>())

  useEffect(() => {
    const currentlyLoading = new Set<string>()
    for (const f of myFetchers) {
      if (f.state !== 'idle') {
        currentlyLoading.add(f.key)
      }
    }

    // Fetchers that just transitioned from loading → idle
    for (const key of prevLoadingKeys.current) {
      if (!currentlyLoading.has(key) && !toastedKeys.current.has(key)) {
        toastedKeys.current.add(key)
        const fetcher = allFetchers.find((f) => f.key === key)
        const d = fetcher?.data as
          | {
              type: string
              message?: string
              rowCount?: number
              durationMs?: number
            }
          | undefined
        if (d?.type === 'error') {
          toast.error(`${report.name} failed`, { description: d.message })
        } else if (d?.type === 'report') {
          toast.success(`${report.name} complete`, {
            description: `${(d.rowCount ?? 0).toLocaleString()} rows in ${((d.durationMs ?? 0) / 1000).toFixed(1)}s`,
          })
        }
      }
    }

    prevLoadingKeys.current = currentlyLoading
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFetchers, report.name])

  /** Spawn a new concurrent fetcher for this report. */
  const runReport = useCallback(() => {
    setKeys((prev) => [...prev, makeReportKey(report.id)])
  }, [report.id])

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
      {/* Hidden fetcher components — one per concurrent submission */}
      {keys.map((key) => (
        <HiddenReportFetcher key={key} fetcherKey={key} intent={report.id} />
      ))}

      <Subheading level={3} className="whitespace-nowrap">
        {report.name}
      </Subheading>
      <div className="mt-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Badge color={report.color}>{report.badge}</Badge>
          {runningCount > 0 && (
            <Badge color="red">{runningCount} running</Badge>
          )}
        </div>
        <Button color="dark/zinc" onClick={runReport}>
          Run Report
        </Button>
      </div>

      {resultData && <ReportResult result={resultData} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Report result display
// ---------------------------------------------------------------------------

function ReportResult({ result }: { result: AnalyticsResult }) {
  const columns =
    result.sampleRows.length > 0 ? Object.keys(result.sampleRows[0]) : []

  return (
    <div className="mt-4 space-y-3">
      <div className="flex gap-3">
        <Badge color="zinc">{result.rowCount.toLocaleString()} rows</Badge>
        <Badge
          color={
            result.durationMs > 10000
              ? 'red'
              : result.durationMs > 5000
                ? 'amber'
                : 'emerald'
          }
        >
          {(result.durationMs / 1000).toFixed(1)}s
        </Badge>
      </div>

      {columns.length > 0 && (
        <div className="overflow-x-auto">
          <Table dense>
            <TableHead>
              <TableRow>
                {columns.map((col) => (
                  <TableHeader key={col}>{col}</TableHeader>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {result.sampleRows.map((row, i) => (
                <TableRow key={i}>
                  {columns.map((col) => (
                    <TableCell key={col}>{formatCellValue(row[col])}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {result.rowCount > result.sampleRows.length && (
            <Text className="mt-2 text-xs">
              Showing {result.sampleRows.length} of{' '}
              {result.rowCount.toLocaleString()} rows
            </Text>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Format a cell value for display. Truncate long strings,
 * format numbers, and handle null/undefined.
 */
function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return value.toLocaleString()
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'

  const str = String(value)
  if (str.length > 40) return `${str.slice(0, 37)}...`
  return str
}
