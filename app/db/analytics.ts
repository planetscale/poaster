import { analyticsPool } from '~/db'
import { getCommentedClient, sqlCommenter } from '~/db/sql-commenter'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by every analytics report runner. */
export interface AnalyticsResult {
  /** Human-readable report name. */
  name: string
  /** Wall-clock execution time in milliseconds. */
  durationMs: number
  /** Total rows returned by the analytical query. */
  rowCount: number
  /** First N rows of the result (for preview in the UI). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sampleRows: Record<string, any>[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run an analytics query inside a transaction that includes a write to
 * `report_snapshots`. The write assigns a transaction ID (xid) which
 * pins the MVCC horizon — preventing VACUUM from cleaning dead tuples
 * while the query runs.
 *
 * Every query is tagged with `action='analytics'` via SQLCommenter so
 * that PlanetScale Traffic Control can identify and govern this class
 * of workload independently from the fast CRUD path.
 */
/**
 * How many extra seconds to hold the transaction open after the heavy
 * query completes. This simulates a realistic analytics pipeline that
 * does post-processing (formatting, writing multiple summary tables,
 * etc.) while still holding its transaction — and keeps the MVCC
 * horizon pinned longer, amplifying dead-tuple bloat.
 */
const POST_QUERY_HOLD_SECONDS = 30

async function runAnalyticsQuery(
  name: string,
  sql: string,
  sampleLimit = 10,
): Promise<AnalyticsResult> {
  const start = performance.now()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[] = []

  await sqlCommenter.run(
    {
      action: 'analytics',
      route: '/admin',
      query: name,
      queryGroup: 'analytics',
    },
    async () => {
      const client = await getCommentedClient(analyticsPool)
      try {
        await client.query('BEGIN')

        const result = await client.query(sql)
        rows = result.rows

        // Write into the same transaction — this is what pins the MVCC
        // horizon. Real analytics pipelines store computed results; we
        // store a snapshot record with the report name and row count.
        await client.query(`INSERT INTO report_snapshots (name) VALUES ($1)`, [
          `${name}: ${rows.length} rows at ${new Date().toISOString()}`,
        ])

        // Hold the transaction open to simulate post-processing work.
        // This keeps the connection occupied on the database server and
        // extends MVCC horizon pinning — a single query now ties up
        // server resources for 40-55 seconds total.
        await client.query(`SELECT pg_sleep(${POST_QUERY_HOLD_SECONDS})`)

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    },
  )

  const durationMs = Math.round(performance.now() - start)

  return {
    name,
    durationMs,
    rowCount: rows.length,
    sampleRows: rows.slice(0, sampleLimit),
  }
}

// ---------------------------------------------------------------------------
// Report definitions
// ---------------------------------------------------------------------------

/**
 * **Engagement Analytics with Percentiles**
 *
 * Per-user, per-action engagement metrics with percentile breakdowns
 * (p50/p95/p99), then compares each user against global averages.
 *
 * ~12s CPU on PS-5 with 2M rows. Three independent full scans of
 * the activity table with PERCENTILE_CONT and COUNT(DISTINCT) over JSONB.
 */
export function runEngagementAnalytics(): Promise<AnalyticsResult> {
  return runAnalyticsQuery(
    'engagementAnalytics',
    `
    WITH per_user_action AS (
      SELECT
        user_id, action, target_type,
        COUNT(*) AS events,
        AVG((metadata->>'latency_ms')::int)::numeric(10,2) AS avg_latency,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS p99,
        COUNT(DISTINCT (metadata->>'client')) AS unique_clients
      FROM activity
      GROUP BY user_id, action, target_type
    ),
    per_user AS (
      SELECT
        user_id, action,
        COUNT(*) AS user_events,
        AVG((metadata->>'latency_ms')::int)::numeric(10,2) AS user_avg,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS user_p95
      FROM activity
      GROUP BY user_id, action
    ),
    overall AS (
      SELECT
        action,
        AVG((metadata->>'latency_ms')::int)::numeric(10,2) AS global_avg,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS global_p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS global_p95
      FROM activity
      GROUP BY action
    )
    SELECT
      ua.user_id, ua.action, ua.target_type,
      ua.events, ua.avg_latency, ua.p50, ua.p95, ua.p99,
      ua.unique_clients,
      u.user_events, u.user_avg, u.user_p95,
      o.global_avg, o.global_p50, o.global_p95,
      (ua.avg_latency - o.global_avg)::numeric(10,2) AS diff_from_global
    FROM per_user_action ua
    JOIN per_user u USING (user_id, action)
    JOIN overall o USING (action)
    ORDER BY ua.events DESC
    `,
  )
}

/**
 * **Trending Posts with Rolling Windows**
 *
 * Hourly activity rates per user and action, then 24-hour rolling
 * windows to detect trends.
 *
 * ~16-19s CPU. Full scan with hourly bucketing, PERCENTILE_CONT per
 * bucket, then window functions over the large intermediate result.
 */
export function runTrendingAnalytics(): Promise<AnalyticsResult> {
  return runAnalyticsQuery(
    'trendingAnalytics',
    `
    WITH hourly AS (
      SELECT
        user_id,
        date_trunc('hour', created_at) AS hour,
        action,
        COUNT(*) AS events,
        AVG((metadata->>'latency_ms')::int)::numeric(10,2) AS avg_latency,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS p99,
        COUNT(*) FILTER (WHERE action = 'delete') AS deletes,
        COUNT(*) FILTER (WHERE action IN ('like', 'repost')) AS engagements
      FROM activity
      GROUP BY user_id, hour, action
    )
    SELECT
      user_id, hour, action, events,
      avg_latency, p50, p95, p99,
      deletes, engagements,
      SUM(events) OVER w AS rolling_24h_events,
      AVG(avg_latency) OVER w AS rolling_24h_latency,
      MAX(p95) OVER w AS rolling_24h_peak_p95
    FROM hourly
    WINDOW w AS (
      PARTITION BY user_id, action ORDER BY hour
      ROWS BETWEEN 23 PRECEDING AND CURRENT ROW
    )
    ORDER BY hour DESC, events DESC
    `,
  )
}

/**
 * **User Activity Report with Cumulative Stats**
 *
 * Daily activity per user with cumulative sums, rankings,
 * day-over-day comparisons (LAG), and 7-day rolling averages.
 *
 * ~15-18s CPU. Five separate window functions each requiring
 * their own sort pass over a large materialized intermediate result.
 */
export function runUserActivityReport(): Promise<AnalyticsResult> {
  return runAnalyticsQuery(
    'userActivityReport',
    `
    WITH daily_usage AS (
      SELECT
        user_id,
        date_trunc('day', created_at) AS day,
        action,
        target_type,
        COUNT(*) AS event_count,
        SUM((metadata->>'latency_ms')::int) AS total_latency_ms,
        AVG((metadata->>'latency_ms')::int)::numeric(10,2) AS avg_latency,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS p95
      FROM activity
      GROUP BY user_id, day, action, target_type
    )
    SELECT
      user_id, day, action, target_type, event_count, total_latency_ms,
      avg_latency, p50, p95,
      SUM(event_count) OVER (PARTITION BY user_id ORDER BY day) AS cumulative_events,
      SUM(total_latency_ms) OVER (PARTITION BY user_id ORDER BY day) AS cumulative_latency,
      RANK() OVER (PARTITION BY day ORDER BY event_count DESC) AS daily_rank,
      LAG(event_count) OVER (PARTITION BY user_id, action, target_type ORDER BY day) AS prev_day,
      AVG(event_count) OVER (
        PARTITION BY user_id, action, target_type ORDER BY day
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
      )::numeric(10,1) AS rolling_7d_avg
    FROM daily_usage
    ORDER BY user_id, day, action, target_type
    `,
  )
}

/**
 * **Tag Co-occurrence and Retention Analysis**
 *
 * Self-join on daily user activity to calculate day-over-day retention,
 * then compares per-user metrics against global daily stats.
 *
 * ~19-25s CPU. The most expensive query. Self-join creates combinatorial
 * explosion; global_daily does a second independent full scan.
 */
export function runRetentionAnalysis(): Promise<AnalyticsResult> {
  return runAnalyticsQuery(
    'retentionAnalysis',
    `
    WITH user_daily AS (
      SELECT
        user_id,
        action,
        date_trunc('day', created_at) AS day,
        COUNT(*) AS usage_count,
        AVG((metadata->>'latency_ms')::int)::numeric(10,2) AS avg_latency,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS p95
      FROM activity
      GROUP BY user_id, action, day
    ),
    daily_summary AS (
      SELECT
        user_id, action, day,
        SUM(usage_count) AS total_usage,
        AVG(avg_latency)::numeric(10,2) AS avg_latency,
        MAX(p95) AS worst_p95
      FROM user_daily
      GROUP BY user_id, action, day
    ),
    retention AS (
      SELECT
        a.user_id, a.action, a.day,
        a.total_usage, a.avg_latency, a.worst_p95,
        b.total_usage AS prev_day_usage,
        CASE WHEN b.total_usage IS NOT NULL THEN true ELSE false END AS retained,
        CASE WHEN b.total_usage > 0
             THEN ((a.total_usage - b.total_usage)::numeric / b.total_usage * 100)::numeric(10,1)
             ELSE NULL END AS usage_change_pct
      FROM daily_summary a
      LEFT JOIN daily_summary b
        ON a.user_id = b.user_id
        AND a.action = b.action
        AND a.day = b.day + interval '1 day'
    ),
    global_daily AS (
      SELECT
        action,
        date_trunc('day', created_at) AS day,
        COUNT(*) AS global_events,
        AVG((metadata->>'latency_ms')::int)::numeric(10,2) AS global_avg,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (metadata->>'latency_ms')::int) AS global_p95
      FROM activity
      GROUP BY action, day
    )
    SELECT
      r.action, r.day,
      COUNT(DISTINCT r.user_id) AS active_users,
      COUNT(DISTINCT r.user_id) FILTER (WHERE r.retained) AS retained_users,
      (COUNT(DISTINCT r.user_id) FILTER (WHERE r.retained)::numeric /
       NULLIF(COUNT(DISTINCT r.user_id), 0) * 100)::numeric(10,1) AS retention_pct,
      SUM(r.total_usage) AS total_usage,
      AVG(r.total_usage)::numeric(10,2) AS avg_per_user,
      AVG(r.avg_latency)::numeric(10,2) AS avg_latency,
      MAX(r.worst_p95) AS worst_p95,
      AVG(r.usage_change_pct)::numeric(10,1) AS avg_change_pct,
      g.global_events, g.global_avg, g.global_p95
    FROM retention r
    JOIN global_daily g ON r.action = g.action AND r.day = g.day
    GROUP BY r.action, r.day, g.global_events, g.global_avg, g.global_p95
    ORDER BY r.action, r.day
    `,
  )
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Seed the `activity` table with ~2M rows of synthetic data using
 * `generate_series`. `user_id` and post `target_id` come from the live
 * `users` and `posts` tables, so a post page can show its own events.
 * Spreads data across 90 days, 7 action types, 3 target types,
 * 4 client platforms, and random latency values.
 *
 * Also runs ANALYZE afterward so the query planner has accurate stats.
 */
export async function seedActivityData(): Promise<{
  rowCount: number
  durationMs: number
}> {
  const start = performance.now()

  await sqlCommenter.run(
    {
      action: 'analytics',
      route: '/admin',
      query: 'seedActivity',
      queryGroup: 'analytics',
    },
    async () => {
      const client = await getCommentedClient(analyticsPool)
      try {
        // Insert 2M rows in a single bulk INSERT using generate_series
        await client.query(`
          WITH ids AS (
            SELECT
              (SELECT array_agg(id) FROM users) AS user_ids,
              (SELECT count(*)::int FROM users) AS user_count,
              (SELECT array_agg(id) FROM posts) AS post_ids,
              (SELECT count(*)::int FROM posts) AS post_count
          )
          INSERT INTO activity (user_id, action, target_type, target_id, metadata, created_at)
          SELECT
            user_id,
            action,
            target_type,
            CASE
              WHEN target_type = 'post' THEN post_id
              ELSE other_id
            END,
            metadata,
            created_at
          FROM (
            SELECT
              ids.user_ids[1 + floor(random() * ids.user_count)::int] AS user_id,
              (ARRAY['post','comment','like','repost','tag','delete','view'])[1 + floor(random() * 7)::int] AS action,
              (ARRAY['post','comment','tag'])[1 + floor(random() * 3)::int] AS target_type,
              ids.post_ids[1 + floor(random() * ids.post_count)::int] AS post_id,
              (random() * 3155 + 1)::int AS other_id,
              jsonb_build_object(
                'client', (ARRAY['web','ios','android','api'])[1 + floor(random() * 4)::int],
                'latency_ms', (random() * 2000)::int
              ) AS metadata,
              now() - (random() * interval '90 days') AS created_at
            FROM generate_series(1, 2000000)
            CROSS JOIN ids
          ) seeded
        `)

        // Update planner statistics
        await client.query('ANALYZE activity')
      } finally {
        client.release()
      }
    },
  )

  const durationMs = Math.round(performance.now() - start)

  return { rowCount: 2000000, durationMs }
}
