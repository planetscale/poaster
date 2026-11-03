# Poaster

A Twitter-like social media demo application that showcases the impact of heavy
analytical queries on real-time CRUD operations in PostgreSQL, and how
[PlanetScale Traffic Control](https://planetscale.com/docs/concepts/traffic-control)
can protect fast-path operations from slow-path interference.

## What it demonstrates

Poaster runs two classes of database queries concurrently:

| Class         | Examples                                                      | Latency requirement | Failure mode if slow                                 |
| ------------- | ------------------------------------------------------------- | ------------------- | ---------------------------------------------------- |
| **Fast path** | Create post, delete post, add comment, add tag                | \<10ms              | Users see lag, feeds stall, real-time features break |
| **Slow path** | Engagement reports, trending calculations, retention analysis | Seconds is fine     | Report is delayed; user can retry                    |

The demo shows that uncontrolled slow-path queries steal CPU and I/O from the
fast path, and that long-running PostgreSQL transactions prevent VACUUM from
cleaning dead tuples — causing index scans on high-churn tables to degrade over
time. Traffic Control can protect fast-path operations by governing the slow
path.

## Stack

- **Framework**: [React Router v7](https://reactrouter.com) (SSR)
- **Frontend**: React 19, Tailwind CSS v4, Headless UI, Tailwind Catalyst
  components
- **Database**: PostgreSQL via PlanetScale,
  [Drizzle ORM](https://orm.drizzle.team)
- **Runtime**: Bun
- **Build**: Vite 7, TypeScript 5 (strict)
- **Other**: TanStack Virtual (virtual scrolling), SQLCommenter (query tagging)

## Getting started

### Prerequisites

- Bun
- A PostgreSQL database (PlanetScale recommended)

### Install

```bash
bun install
```

### Configure

Copy `.env.template` to `.env` and fill in your database URL:

```bash
cp .env.template .env
```

```env
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
API_KEY=                          # API key for the onramp load generator
ONRAMP_URL=http://localhost:8080  # onramp server address (default shown)
```

### Set up the database

Generate and run migrations:

```bash
bun db:generate
bun db:migrate
```

### Run in development

```bash
bun dev
```

The app runs at `http://localhost:5173`.

## Scripts

| Script            | Description                                     |
| ----------------- | ----------------------------------------------- |
| `bun dev`         | Start development server with HMR               |
| `bun build`       | Build for production                            |
| `bun start`       | Start production server                         |
| `bun typecheck`   | Run TypeScript type checking                    |
| `bun lint`        | Lint with Oxlint (fixes automatically)          |
| `bun format`      | Format with Prettier                            |
| `bun db:generate` | Generate Drizzle migrations from schema changes |
| `bun db:migrate`  | Apply pending migrations to the database        |

## Docker

Multi-stage build optimized for production:

```bash
docker build -t poaster .
docker run -e DATABASE_URL=<your-database-url> -p 3000:3000 poaster
```

## Project structure

```
app/
├── routes/               # File-based route handlers
│   ├── _index.tsx        # Homepage: virtualized, polled feed
│   ├── admin.tsx         # Admin dashboard: runs heavy analytics reports
│   ├── engine.tsx        # Engine dashboard: controls onramp load generator
│   ├── api.posts.ts      # GET /api/posts — infinite scroll loader
│   ├── api.posts.count.ts # GET /api/posts/count — polling endpoint
│   ├── posts.$postId.tsx # Post detail page
│   ├── users.$userId.tsx # User profile page
│   └── tags.$tagName.tsx # Tag page
├── components/           # Reusable UI components
├── db/
│   ├── schema.ts         # Drizzle ORM schema definitions
│   ├── queries.ts        # Feed queries, trending tags
│   ├── analytics.ts      # Heavy analytical queries (slow path)
│   ├── sql-commenter.ts  # SQLCommenter tag injection helper
│   └── index.ts          # Database client and connection pool
└── lib/                  # Shared utilities
```

## How the demo works

### Feed (fast path)

The homepage displays a live feed of posts and comments. It polls
`/api/posts/count` every 2 seconds to check for new content, using a toggle to
switch between manual and auto-refresh modes. The feed uses virtual scrolling
(TanStack Virtual) to handle large result sets efficiently.

All fast-path queries are tagged with `/* action='fast' */` via SQLCommenter so
Traffic Control can identify and protect them.

### Admin dashboard (slow path)

The `/admin` route runs four heavy analytical queries against a 2-million-row
`activity` table. Each query is designed to run for 10–25 seconds on a small
database instance:

1. **Engagement analytics** — per-user, per-action metrics with
   `PERCENTILE_CONT` at p50/p95/p99 across three full table scans (~12s)
1. **Trending with rolling windows** — hourly bucketing plus 24-hour window
   functions over a large intermediate result (~16–19s)
1. **User activity report** — daily bucketing with cumulative sums, `LAG` for
   day-over-day deltas, and 7-day rolling averages (~15–18s)
1. **Retention analysis** — self-join on daily summary to calculate day-over-day
   retention, plus a second full scan for global stats (~19–25s)

Each analytics query runs inside a transaction that writes to
`report_snapshots`. This write assigns a transaction ID (xid), pinning the MVCC
horizon and preventing VACUUM from cleaning dead tuples from high-churn tables —
which is what causes the fast path to degrade over time.

All slow-path queries are tagged with `/* action='analytics' */`.

### Engine dashboard (load generator)

The `/engine` route is a control panel for **onramp**, a virtual-user load
generator that runs query flows against the database. It requires the
`ONRAMP_URL` and `API_KEY` environment variables.

The dashboard has three panels:

- **Hammer** — start/stop the simulation with a single click
- **User Config** — tune spawn rates (`NewUsersPerSecond`,
  `DeletedUsersPerSecond`), flow delay, and the min/max active-user bounds
- **Flows** — edit named query flows as JSON. Each flow has a `Weight`
  (relative probability) and a list of SQL `Queries` written as Go templates.
  Available template variables: `{{.UserID}}`, `{{Name}}`, `{{Email}}`,
  `{{Word}}`, `{{Sentence N}}`, `{{UUID}}`

### Traffic Control

With PlanetScale Traffic Control configured to govern `action='analytics'`
queries, the admin reports get queued or rejected during peak load while the
feed remains responsive. The application includes exponential backoff retry
logic for throttled queries.

## Database schema

| Table              | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `users`            | User profiles                                                 |
| `posts`            | Feed posts                                                    |
| `comments`         | Comments on posts                                             |
| `tags`             | Topic tags                                                    |
| `post_tags`        | Many-to-many join between posts and tags                      |
| `activity`         | 2M-row event log used by analytical queries                   |
| `report_snapshots` | Written inside analytics transactions to pin the MVCC horizon |

### Seeding analytics data

To reproduce the demo's performance characteristics, seed the `activity` table
with ~2 million rows:

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

ANALYZE activity;
```

## Further reading

See [`GUIDANCE.md`](./GUIDANCE.md) for a detailed explanation of the query
design, MVCC pinning mechanics, stress test structure, what metrics to track,
and common mistakes when reproducing this demo pattern.
