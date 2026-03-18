# Guidance: Designing Heavy Queries to Stress-Test a Twitter Clone

This document is for developers building a separate application (a Twitter-like clone with posts, comments, and tags) who want to reproduce the same demo pattern shown in this project: a class of fast CRUD operations that must run at maximum velocity, and a class of heavy analytical queries that can be throttled and retried without harm.

The goal is to demonstrate that when both query classes share a Postgres database, uncontrolled analytical queries degrade the CRUD path, and that PlanetScale's Traffic Control can protect the fast path by governing the slow path.

---

## Table of contents

- [The two query classes](#the-two-query-classes)
- [Design your schema for the demo](#design-your-schema-for-the-demo)
- [Seed enough data to make analytics expensive](#seed-enough-data-to-make-analytics-expensive)
- [The fast path: high-frequency CRUD](#the-fast-path-high-frequency-crud)
- [The slow path: analytical queries that consume real resources](#the-slow-path-analytical-queries-that-consume-real-resources)
  - [Why these queries are expensive](#why-these-queries-are-expensive)
  - [Query 1: Engagement analytics with percentiles](#query-1-engagement-analytics-with-percentiles)
  - [Query 2: Trending posts with rolling windows](#query-2-trending-posts-with-rolling-windows)
  - [Query 3: User activity report with cumulative stats](#query-3-user-activity-report-with-cumulative-stats)
  - [Query 4: Tag co-occurrence and retention analysis](#query-4-tag-co-occurrence-and-retention-analysis)
- [How to make the analytics actually hurt](#how-to-make-the-analytics-actually-hurt)
- [SQLCommenter tagging](#sqlcommenter-tagging)
- [The stress test structure](#the-stress-test-structure)
- [Retry logic for throttled queries](#retry-logic-for-throttled-queries)
- [What to measure](#what-to-measure)
- [Common mistakes](#common-mistakes)

---

## The two query classes

| Class                     | Examples                                                                     | Latency requirement        | Failure mode if slow                                 |
| ------------------------- | ---------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------- |
| **Fast path (CRUD)**      | Create post, delete post, add comment, add tag                               | <10ms per operation        | Users see lag, feeds stall, real-time features break |
| **Slow path (analytics)** | Engagement reports, trending calculations, usage billing, retention analysis | Seconds to minutes is fine | Report is delayed; user can retry or wait            |

The demo shows that uncontrolled slow-path queries steal CPU, I/O, and memory from the fast path, and on Postgres specifically, long-running transactions prevent VACUUM from cleaning dead tuples, which causes index scans on high-churn tables to degrade.

---

## Design your schema for the demo

You need two things: **a high-churn table** that the fast path constantly writes to and deletes from, and **a large analytics table** that the slow path scans.

For a Twitter clone, the high-churn table is your feed/timeline queue or notification queue (constant INSERT/DELETE cycles). The analytics table is your events or activity log.

Example schema:

```sql
-- High-churn table: the "queue" that degrades under MVCC bloat
CREATE TABLE notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER     NOT NULL,
  type       TEXT        NOT NULL,  -- 'mention', 'like', 'repost', 'follow', 'reply'
  data       JSONB       DEFAULT '{}',
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user_unread
  ON notifications (user_id, created_at)
  WHERE read_at IS NULL;

-- Large analytics table: where heavy queries run
CREATE TABLE activity (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER     NOT NULL,
  action      TEXT        NOT NULL,  -- 'post', 'comment', 'like', 'repost', 'tag', 'delete', 'view'
  target_type TEXT        NOT NULL,  -- 'post', 'comment', 'tag'
  target_id   BIGINT,
  metadata    JSONB       DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_user ON activity (user_id, created_at);
CREATE INDEX idx_activity_action ON activity (action, created_at);

-- Lookup table for tag relationships (used in co-occurrence queries)
CREATE TABLE post_tags (
  post_id BIGINT NOT NULL,
  tag     TEXT   NOT NULL,
  PRIMARY KEY (post_id, tag)
);
CREATE INDEX idx_post_tags_tag ON post_tags (tag);

-- Write target for analytics transactions (pins MVCC horizon)
CREATE TABLE report_snapshots (
  id   BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL
);
```

The `notifications` table is the victim: it has extremely high tuple churn (constant INSERT when events happen, DELETE or UPDATE when read/dismissed), making its indexes the most sensitive to MVCC bloat. The `activity` table is the target of expensive analytical queries.

---

## Seed enough data to make analytics expensive

The analytics queries need to be genuinely expensive. On a small PlanetScale Postgres instance (PS-5: 1/16 vCPU, 512MB RAM), you want each query to take **10-25 seconds of CPU time**. This requires:

- **~2 million rows** in the `activity` table
- **~500k rows** in `post_tags`
- Data spread across **enough distinct values** to make aggregations non-trivial (200+ users, 90 days of timestamps, 7+ action types)

Use `generate_series` with random data to seed in bulk:

```sql
INSERT INTO activity (user_id, action, target_type, target_id, metadata, created_at)
SELECT
  (random() * 199 + 1)::integer,
  (ARRAY['post','comment','like','repost','tag','delete','view'])[floor(random() * 7 + 1)::integer],
  (ARRAY['post','comment','tag'])[floor(random() * 3 + 1)::integer],
  (random() * 500000 + 1)::bigint,
  jsonb_build_object(
    'client', (ARRAY['web','ios','android','api'])[floor(random() * 4 + 1)::integer],
    'latency_ms', (random() * 2000)::integer
  ),
  now() - (random() * interval '90 days')
FROM generate_series(1, 2000000);

INSERT INTO post_tags (post_id, tag)
SELECT DISTINCT ON (post_id, tag)
  (random() * 500000 + 1)::bigint,
  (ARRAY['tech','music','sports','politics','gaming','food','travel',
         'science','art','finance','health','education','humor','news',
         'crypto','ai','climate','books','film','photography'])[floor(random() * 20 + 1)::integer]
FROM generate_series(1, 600000);
```

After seeding, run `ANALYZE activity; ANALYZE post_tags;` so the query planner has accurate statistics.

**Validate your queries are expensive enough** before building the stress test. Each should take 10+ seconds on your target instance size. If they complete in <5 seconds, add more rows or make the queries more complex (add more CTEs, more `PERCENTILE_CONT` calls, more window functions).

---

## The fast path: high-frequency CRUD

Your CRUD operations should be simple, indexed queries that complete in 1-5ms under normal conditions. The demo runs these continuously at high throughput to generate dead tuples:

```sql
-- Create a notification (INSERT)
INSERT INTO notifications (user_id, type, data)
VALUES (42, 'mention', '{"post_id": 12345}');

-- Mark notifications as read (UPDATE, creates dead tuples)
UPDATE notifications SET read_at = now()
WHERE user_id = 42 AND read_at IS NULL;

-- Delete old notifications (DELETE, creates dead tuples)
DELETE FROM notifications
WHERE user_id = 42 AND read_at < now() - interval '7 days';

-- Log activity (INSERT into analytics table)
INSERT INTO activity (user_id, action, target_type, target_id)
VALUES (42, 'post', 'post', 12345);
```

The key metric to track is the **time it takes to acquire a lock** on the notifications table (the `SELECT ... FOR UPDATE SKIP LOCKED` if you're using a queue pattern, or the total round-trip time for INSERT/UPDATE/DELETE operations). This is what degrades when MVCC bloat accumulates.

---

## The slow path: analytical queries that consume real resources

Each query below is designed to be expensive in a specific way. Real analytics dashboards run queries like these. The goal is not to write absurd queries -- it's to write **realistic queries that happen to require full table scans, sorting, and heavy aggregation** because that's what analytics does.

### Why these queries are expensive

A query becomes expensive enough to interfere with the fast path when it does some combination of:

1. **Full table scan** -- reads all 2M rows (no `WHERE` clause that limits to an indexed subset)
2. **`PERCENTILE_CONT`** -- requires sorting the entire result set to compute percentiles; cannot be streamed
3. **Multiple `GROUP BY` passes** -- each CTE independently scans the table, multiplying the I/O
4. **Window functions** (`OVER`, `ROWS BETWEEN`) -- require materialization and sorting of intermediate results
5. **Self-joins** -- a CTE joined to itself on `day + interval '1 day'` creates a combinatorial explosion
6. **`COUNT(DISTINCT ...)` across JSONB** -- extracts and deduplicates values from JSON fields, which is CPU-intensive
7. **Large intermediate result sets** -- CTEs that produce 50k-200k rows that then get joined, sorted, and windowed

The queries below combine 3-5 of these techniques each. On a PS-5 with 2M rows, each takes 10-25 seconds of CPU. On a larger instance, you may need more rows or more complex queries.

### Query 1: Engagement analytics with percentiles

_~12s CPU on PS-5 with 2M rows. Three independent full scans of the activity table._

This is the "tenant usage dashboard" query. It computes per-user, per-action engagement metrics with percentile breakdowns, then compares each user against global averages.

```sql
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
```

Why it's expensive: Three CTEs each do a full scan of the 2M-row activity table. Each scan includes `PERCENTILE_CONT` (which requires an in-memory sort), `COUNT(DISTINCT ...)` over JSONB fields, and `GROUP BY` with many distinct groups. The final `JOIN` produces a large result set that must be sorted.

### Query 2: Trending posts with rolling windows

_~16-19s CPU. Full scan with hourly bucketing, then window functions over the intermediate result._

This is the "trending dashboard" query. It computes hourly activity rates per user and action, then applies 24-hour rolling windows to detect trends.

```sql
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
```

Why it's expensive: The CTE produces tens of thousands of hourly buckets (200 users x 2,160 hours x 7 actions). Each bucket requires `PERCENTILE_CONT` sorting. The window functions then scan across this large intermediate result, requiring materialization and per-partition sorting. The `ORDER BY hour DESC, events DESC` at the end forces a final sort of the entire output.

### Query 3: User activity report with cumulative stats

_~15-18s CPU. Daily bucketing, then cumulative window functions and LAG for day-over-day deltas._

This is the "billing/usage report" query. It computes daily activity per user, then applies cumulative sums, rankings, day-over-day comparisons, and 7-day rolling averages.

```sql
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
```

Why it's expensive: The CTE produces a large intermediate result (200 users x 90 days x 7 actions x 3 target types = potentially 350k+ rows). Five separate window functions each require their own sort pass over this materialized result. The `LAG` and rolling average windows partition by `(user_id, action, target_type)`, creating thousands of small partitions that the executor must track.

### Query 4: Tag co-occurrence and retention analysis

_~19-25s CPU. The most expensive query. Self-join on daily summary creates combinatorial explosion._

This is the "content insights" query. It computes daily activity per user, then self-joins to calculate day-over-day retention (did users who were active on day N come back on day N+1?), and compares per-user metrics against global daily stats.

```sql
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
```

Why it's expensive: The `retention` CTE does a self-join on `daily_summary` matching each (user, action, day) row to the same user's previous day. With 200 users x 7 actions x 90 days, the join processes ~126k row pairs. The `global_daily` CTE independently scans the full 2M-row activity table again. The final aggregation groups by (action, day) with `COUNT(DISTINCT)` and `FILTER`, requiring yet another materialization pass.

---

## How to make the analytics actually hurt

Writing expensive queries is necessary but not sufficient. The queries must actually degrade the fast path. There are two mechanisms, and you want both:

### 1. CPU/IO contention (immediate)

Heavy queries consume CPU and I/O bandwidth that the fast path needs. When an analytics query is saturating the CPU computing `PERCENTILE_CONT` over 2M rows, your `INSERT INTO notifications` has to wait for a CPU time slice. This causes immediate, proportional slowdown.

**How to maximize this:** Run multiple analytics queries concurrently. One query might use 50% of a vCPU. Three concurrent queries will fight each other and the CRUD operations for every CPU cycle.

### 2. MVCC horizon pinning (accumulative, Postgres-specific)

This is the more insidious mechanism. When an analytics query runs inside a **transaction that includes a write**, it gets assigned a transaction ID (xid). As long as that transaction is open, Postgres's VACUUM cannot remove dead tuples that were created after the transaction started. Dead tuples accumulate in the indexes of high-churn tables (like `notifications`), and every `SELECT ... FOR UPDATE` or indexed lookup must scan through them.

**The critical pattern:** each analytics query must be wrapped in a transaction that includes a write:

```javascript
await sql.begin(async (tx) => {
  // 1. Run the heavy aggregation query
  const rows = await tx.query(analyticsQuery)

  // 2. Write the result — THIS IS WHAT PINS THE MVCC HORIZON
  //    The INSERT assigns a transaction ID (xid). While this
  //    transaction is open, VACUUM cannot clean dead tuples
  //    from ANY table in the database — including the notifications
  //    table that the fast path depends on.
  await tx.query(`
    INSERT INTO report_snapshots (name)
    VALUES ('engagement report: ${rows.length} rows at ${new Date().toISOString()}')
  `)
})
```

Without the write, a read-only transaction may not pin the MVCC horizon in the same way (depending on isolation level). Including a write is what makes this realistic -- real analytics pipelines compute a report and store the result in the same transaction.

**How to maximize this:** Schedule analytics queries so they overlap in time. If each takes 15 seconds and you fire one every 5 seconds, you'll have 3 concurrent transactions pinning the MVCC horizon simultaneously. VACUUM gets no window to clean up, and dead tuples accumulate monotonically.

---

## SQLCommenter tagging

Every query must include a SQLCommenter tag so that Traffic Control can identify which class it belongs to. Append a trailing SQL comment with key-value pairs:

```sql
-- Fast path operations
INSERT INTO notifications (...) VALUES (...) /* action='crud' */
UPDATE notifications SET read_at = now() ... /* action='crud' */
DELETE FROM notifications WHERE ...          /* action='crud' */

-- Slow path analytics
WITH per_user_action AS (...) SELECT ...     /* action='analytics' */
INSERT INTO report_snapshots (name) ...      /* action='analytics' */

-- Monitoring (should not be throttled)
SELECT COUNT(*) FROM notifications           /* action='monitor' */
SELECT n_dead_tup FROM pg_stat_all_tables    /* action='monitor' */
```

The tag format is `/* key='value' */`. Traffic Control in PlanetScale's dashboard targets queries by matching on these tags. You configure a rule that says "queries with `action='analytics'` get 50% of server capacity and max 2 concurrent workers" -- the fast path queries with `action='crud'` are unaffected.

A simple helper function to append tags:

```typescript
function tag(query: string, tags: Record<string, string>): string {
  const comment = Object.entries(tags)
    .map(([k, v]) => `${k}='${v}'`)
    .join(' ')
  return `${query} /* ${comment} */`
}
```

---

## The stress test structure

The demo has three concurrent loops:

### 1. Producer loop (simulates user activity)

Continuously inserts notifications and activity rows at a configurable rate. Start at a baseline rate, ramp up to simulate a traffic spike, then ramp back down.

```
Rate (operations/s)
1500 |           /\
     |         /    \
 200 |--------/      \--------
     0   60  300  600  720s
```

### 2. Worker loop (processes the fast path)

Multiple concurrent workers that read from the notifications table, process them, and delete them. This is the operation whose latency you're measuring. Track the time for each operation and log it.

### 3. Analytics scheduler (fires heavy queries)

Fires analytics queries at predetermined times, clustered around the peak traffic period. The convergence of peak CRUD throughput and clustered analytics is where the degradation becomes visible.

Schedule example for a 12-minute run:

```
Time:   30s    90s    150s   260s  270s  300s  310s   370s  380s   480s   620s
Query:   Q1     Q4     Q2    Q1    Q3    Q4    Q2     Q1    Q3     Q2     Q4
                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                        Convergence zone: analytics cluster
                        overlaps with peak CRUD throughput
```

The early and late queries establish that analytics work fine at baseline. The clustered queries during peak traffic create the degradation. This makes the cause-and-effect relationship visible in the metrics.

---

## Retry logic for throttled queries

When Traffic Control is enabled, blocked analytics queries receive an immediate error (not a timeout -- the query is rejected before it starts). Your application should catch these and retry with exponential backoff:

```typescript
const RETRY_CONFIG = {
  baseDelayMs: 5000, // 5s initial backoff
  multiplier: 2, // exponential: 5s, 10s, 20s, 40s...
  maxDelayMs: 60000, // 60s cap
  jitter: 0.2, // +/-20% randomization
  maxAttempts: 20, // give up eventually
}

function getRetryDelay(attempt: number): number {
  const base = Math.min(
    RETRY_CONFIG.baseDelayMs * Math.pow(RETRY_CONFIG.multiplier, attempt - 1),
    RETRY_CONFIG.maxDelayMs,
  )
  const jitter = base * RETRY_CONFIG.jitter * (Math.random() * 2 - 1)
  return Math.max(1000, base + jitter)
}

async function runAnalyticsWithRetry(query: string, name: string) {
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      await sql.begin(async (tx) => {
        const rows = await tx.query(tag(query, { action: 'analytics' }))
        await tx.query(
          tag(
            `INSERT INTO report_snapshots (name)
           VALUES ('${name}: ${rows.length} rows')`,
            { action: 'analytics' },
          ),
        )
      })
      return // success
    } catch (err) {
      if (err.message?.includes('Traffic Control')) {
        // TC blocked this query -- retry after backoff
        const delay = getRetryDelay(attempt)
        console.log(`[analytics] Blocked: "${name}", retry in ${delay}ms`)
        await sleep(delay)
        continue
      }
      throw err // non-TC errors should not be retried
    }
  }
  console.log(
    `[analytics] Gave up: "${name}" after ${RETRY_CONFIG.maxAttempts} attempts`,
  )
}
```

Key points:

- Only retry Traffic Control blocks, not other errors (statement timeouts, connection failures, etc.)
- Exponential backoff with jitter prevents retry storms
- The 5-second base delay gives the token bucket time to refill
- Track retry counts and total wait time in your metrics

---

## What to measure

Log these metrics every second to a CSV file:

| Metric                     | How to get it                                                                                             | What it shows                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **CRUD operation latency** | Time the INSERT/UPDATE/DELETE                                                                             | Primary indicator of fast-path health     |
| **Queue depth**            | `SELECT COUNT(*) FROM notifications WHERE read_at IS NULL`                                                | Whether workers are keeping up            |
| **Dead tuples**            | `SELECT n_dead_tup FROM pg_stat_all_tables WHERE relname = 'notifications'`                               | MVCC bloat accumulation                   |
| **Oldest transaction age** | `SELECT EXTRACT(EPOCH FROM (now() - MIN(xact_start))) FROM pg_stat_activity WHERE xact_start IS NOT NULL` | How long the MVCC horizon has been pinned |
| **Throughput**             | Operations completed / elapsed time                                                                       | Effective worker capacity                 |
| **Analytics active**       | Count of currently-running analytics queries                                                              | Correlate with degradation                |
| **Analytics waiting**      | Count of queries in retry backoff                                                                         | TC is actively protecting                 |
| **Analytics retries**      | Total retry count                                                                                         | Cost of throttling                        |

The story you're telling with the metrics:

1. **Baseline period (no analytics):** CRUD latency is low, dead tuples cycle normally, throughput is steady.
2. **Analytics begin:** Dead tuples start climbing, CRUD latency increases, throughput drops.
3. **Convergence zone (peak traffic + clustered analytics):** Dead tuples spike, CRUD latency spikes, queue depth grows. This is the failure mode.
4. **With Traffic Control:** Analytics are blocked during peak, dead tuples stay controlled, CRUD latency stays near baseline. The analytics eventually complete when load subsides.

---

## Common mistakes

### Queries that finish too fast

If your analytics queries complete in <5 seconds, they won't pin the MVCC horizon long enough to cause visible degradation. Solutions:

- Add more seed data (4M rows instead of 2M)
- Add more `PERCENTILE_CONT` calculations
- Add more CTEs that independently scan the full table
- Remove `LIMIT` clauses from intermediate results
- Add self-joins (Query 4 pattern)

### Not including a write in the analytics transaction

A pure `SELECT` may not assign a transaction ID on all Postgres versions and isolation levels. Always include an `INSERT INTO report_snapshots` (or equivalent write) inside the analytics transaction. This is also realistic -- real analytics pipelines store their results.

### Running from a different region than your database

MVCC degradation adds microseconds-to-milliseconds of index scan time. If your network round trip is 100ms, this is invisible. **Always run your stress test from a machine in the same cloud region as your database.** A 1-2ms baseline round trip makes a 10ms degradation clearly visible.

### Not overlapping analytics queries

A single 15-second analytics transaction gives VACUUM a 5-15 second window between transactions. VACUUM can often keep up. The damage happens when transactions **overlap** so VACUUM never gets a window. Fire 3-4 queries within a 10-second span during peak traffic.

### Measuring averages instead of percentiles

Average CRUD latency might look fine (4ms vs 2ms baseline, who cares?). But the p99 might be 150ms vs 5ms. Track percentiles or at least max values. The occasional lock time spike to 100ms+ is what causes real-world queue backlogs and timeout errors.

### Forgetting to tag queries

Without SQLCommenter tags, Traffic Control has nothing to key on. Tag every query from the start. Tags are also useful as documentation of query intent in `pg_stat_activity` and query logs.
