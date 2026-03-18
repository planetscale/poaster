import { useEffect, useRef, useState } from 'react'
import { data, useFetcher } from 'react-router'
import { toast } from 'sonner'

import type { Route } from './+types/engine'
import { Badge } from '~/components/badge'
import { Button } from '~/components/button'
import { Divider } from '~/components/divider'
import { Heading, Subheading } from '~/components/heading'
import { Text } from '~/components/text'

// ---------------------------------------------------------------------------
// Types — match onramp Go structs (no json tags → PascalCase field names)
// UserFlowDelay is time.Duration serialized as int64 nanoseconds
// ---------------------------------------------------------------------------

interface Flow {
  Name: string
  Weight: number
  Queries: string[]
}

interface UserConfig {
  TotalUsers: number
  NewUsersPerSecond: number
  DeletedUsersPerSecond: number
  UserFlowDelay: number // nanoseconds
  MaxUsers: number
  MinUsers: number
  Flows: Flow[]
}

// ---------------------------------------------------------------------------
// Onramp API helpers (server-side only)
// ---------------------------------------------------------------------------

function onrampBase() {
  return process.env.ONRAMP_URL ?? 'http://localhost:8080'
}

function apiKey() {
  return process.env.API_KEY ?? ''
}

async function onrampFetch(path: string, init?: RequestInit) {
  return fetch(`${onrampBase()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey(),
      ...(init?.headers ?? {}),
    },
  })
}

// ---------------------------------------------------------------------------
// Loader — fetch current config + flows
// ---------------------------------------------------------------------------

export async function loader() {
  try {
    const [configRes, flowsRes] = await Promise.all([
      onrampFetch('/users'),
      onrampFetch('/users/flows'),
    ])

    if (!configRes.ok || !flowsRes.ok) {
      return data({
        config: null as UserConfig | null,
        flows: null as Flow[] | null,
        error: 'onramp returned an error — is it running?',
      })
    }

    const config: UserConfig = await configRes.json()
    const flows: Flow[] = await flowsRes.json()
    return data({ config, flows, error: null })
  } catch (err) {
    return data({
      config: null as UserConfig | null,
      flows: null as Flow[] | null,
      error: err instanceof Error ? err.message : 'Failed to connect to onramp',
    })
  }
}

// ---------------------------------------------------------------------------
// Action — mutations proxied to onramp
// ---------------------------------------------------------------------------

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData()
  const intent = formData.get('intent') as string

  if (intent === 'start' || intent === 'stop') {
    try {
      const res = await onrampFetch(`/hammer/${intent}`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        return data({
          type: 'error' as const,
          intent,
          message: (body as { error?: string }).error ?? 'Unknown error',
        })
      }
      return data({ type: 'hammer' as const, intent, status: (body as { status: string }).status })
    } catch (err) {
      return data({
        type: 'error' as const,
        intent,
        message: err instanceof Error ? err.message : 'Failed',
      })
    }
  }

  if (intent === 'update-config') {
    const raw = formData.get('config') as string
    try {
      const config = JSON.parse(raw) as UserConfig
      const res = await onrampFetch('/users', {
        method: 'POST',
        body: JSON.stringify(config),
      })
      const body = await res.json()
      if (!res.ok) {
        return data({
          type: 'error' as const,
          intent,
          message: (body as { error?: string }).error ?? 'Unknown error',
        })
      }
      return data({ type: 'config' as const, config: body as UserConfig })
    } catch (err) {
      return data({
        type: 'error' as const,
        intent,
        message: err instanceof Error ? err.message : 'Failed',
      })
    }
  }

  if (intent === 'update-flows') {
    const raw = formData.get('flows') as string
    try {
      const flows = JSON.parse(raw) as Flow[]
      const res = await onrampFetch('/users/flows', {
        method: 'POST',
        body: JSON.stringify(flows),
      })
      const body = await res.json()
      if (!res.ok) {
        return data({
          type: 'error' as const,
          intent,
          message: (body as { error?: string }).error ?? 'Unknown error',
        })
      }
      return data({ type: 'flows' as const, flows: body as Flow[] })
    } catch (err) {
      return data({
        type: 'error' as const,
        intent,
        message: err instanceof Error ? err.message : 'Failed',
      })
    }
  }

  return data({ type: 'error' as const, intent, message: `Unknown intent: ${intent}` })
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EnginePage({ loaderData }: Route.ComponentProps) {
  const { config, flows, error } = loaderData

  if (error) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-4 lg:p-6">
        <Heading>Engine</Heading>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
          <Text className="text-red-700 dark:text-red-300">
            Could not reach onramp: {error}
          </Text>
          <Text className="mt-1 text-sm text-red-600 dark:text-red-400">
            Make sure <code className="font-mono">onramp serve</code> is running and{' '}
            <code className="font-mono">API_KEY</code> / <code className="font-mono">ONRAMP_URL</code> are set.
          </Text>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-4 lg:p-6">
      <Heading>Engine</Heading>

      <HammerControls />

      <Divider />

      <ConfigEditor initialConfig={config!} />

      <Divider />

      <FlowsEditor initialFlows={flows!} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hammer start / stop
// ---------------------------------------------------------------------------

function HammerControls() {
  const fetcher = useFetcher<typeof action>()
  const isSubmitting = fetcher.state !== 'idle'

  const prevState = useRef(fetcher.state)
  useEffect(() => {
    if (prevState.current !== 'idle' && fetcher.state === 'idle' && fetcher.data) {
      const d = fetcher.data
      if (d.type === 'error') {
        toast.error(`Hammer ${d.intent}`, { description: d.message })
      } else if (d.type === 'hammer') {
        toast.success(`Hammer ${d.status}`)
      }
    }
    prevState.current = fetcher.state
  }, [fetcher.state, fetcher.data])

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
      <Subheading level={2}>Hammer</Subheading>
      <Text className="mt-1 text-sm">Start or stop the virtual-user load simulation.</Text>
      <div className="mt-4 flex gap-3">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="start" />
          <Button type="submit" color="emerald" disabled={isSubmitting}>
            Start
          </Button>
        </fetcher.Form>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="stop" />
          <Button type="submit" color="red" disabled={isSubmitting}>
            Stop
          </Button>
        </fetcher.Form>
        {isSubmitting && <Badge color="amber">working…</Badge>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// User config editor
// ---------------------------------------------------------------------------

function ConfigEditor({ initialConfig }: { initialConfig: UserConfig }) {
  // UserFlowDelay arrives in nanoseconds; display/edit in milliseconds
  const nsToMs = (ns: number) => ns / 1_000_000
  const msToNs = (ms: number) => Math.round(ms * 1_000_000)

  const [cfg, setCfg] = useState<UserConfig>(initialConfig)
  const [delayMs, setDelayMs] = useState(() => nsToMs(initialConfig.UserFlowDelay))

  const fetcher = useFetcher<typeof action>()
  const isSaving = fetcher.state !== 'idle'

  const prevState = useRef(fetcher.state)
  useEffect(() => {
    if (prevState.current !== 'idle' && fetcher.state === 'idle' && fetcher.data) {
      const d = fetcher.data
      if (d.type === 'error') {
        toast.error('Config update failed', { description: d.message })
      } else if (d.type === 'config') {
        setCfg(d.config)
        setDelayMs(nsToMs(d.config.UserFlowDelay))
        toast.success('Config updated')
      }
    }
    prevState.current = fetcher.state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data])

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const payload: UserConfig = { ...cfg, UserFlowDelay: msToNs(delayMs) }
    const form = new FormData()
    form.set('intent', 'update-config')
    form.set('config', JSON.stringify(payload))
    fetcher.submit(form, { method: 'post' })
  }

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
      <div className="flex items-center justify-between gap-4">
        <Subheading level={2}>User Config</Subheading>
        <Badge color="zinc">
          {cfg.TotalUsers} active user{cfg.TotalUsers !== 1 ? 's' : ''}
        </Badge>
      </div>
      <Text className="mt-1 text-sm">
        Controls how virtual users are spawned and how fast they execute flows.
      </Text>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <NumberField
            label="New users / sec"
            value={cfg.NewUsersPerSecond}
            step={0.1}
            min={0}
            onChange={(v) => setCfg((c) => ({ ...c, NewUsersPerSecond: v }))}
          />
          <NumberField
            label="Deleted users / sec"
            value={cfg.DeletedUsersPerSecond}
            step={0.1}
            min={0}
            onChange={(v) => setCfg((c) => ({ ...c, DeletedUsersPerSecond: v }))}
          />
          <NumberField
            label="Flow delay (ms)"
            value={delayMs}
            step={50}
            min={0}
            onChange={setDelayMs}
          />
          <NumberField
            label="Min users"
            value={cfg.MinUsers}
            step={1}
            min={0}
            onChange={(v) => setCfg((c) => ({ ...c, MinUsers: v }))}
          />
          <NumberField
            label="Max users"
            value={cfg.MaxUsers}
            step={1}
            min={0}
            onChange={(v) => setCfg((c) => ({ ...c, MaxUsers: v }))}
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" color="dark/zinc" disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save Config'}
          </Button>
        </div>
      </form>
    </div>
  )
}

function NumberField({
  label,
  value,
  step,
  min,
  onChange,
}: {
  label: string
  value: number
  step: number
  min: number
  onChange: (v: number) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-900 dark:text-white"
      />
    </label>
  )
}

// ---------------------------------------------------------------------------
// Flows editor
// ---------------------------------------------------------------------------

function FlowsEditor({ initialFlows }: { initialFlows: Flow[] }) {
  const [json, setJson] = useState(() => JSON.stringify(initialFlows, null, 2))
  const [parseError, setParseError] = useState<string | null>(null)

  const fetcher = useFetcher<typeof action>()
  const isSaving = fetcher.state !== 'idle'

  const prevState = useRef(fetcher.state)
  useEffect(() => {
    if (prevState.current !== 'idle' && fetcher.state === 'idle' && fetcher.data) {
      const d = fetcher.data
      if (d.type === 'error') {
        toast.error('Flows update failed', { description: d.message })
      } else if (d.type === 'flows') {
        setJson(JSON.stringify(d.flows, null, 2))
        toast.success('Flows updated')
      }
    }
    prevState.current = fetcher.state
  }, [fetcher.state, fetcher.data])

  function handleChange(raw: string) {
    setJson(raw)
    try {
      JSON.parse(raw)
      setParseError(null)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Invalid JSON')
    }
  }

  function handlePrettify() {
    try {
      setJson(JSON.stringify(JSON.parse(json), null, 2))
      setParseError(null)
    } catch {
      // leave as-is
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (parseError) return
    const form = new FormData()
    form.set('intent', 'update-flows')
    form.set('flows', json)
    fetcher.submit(form, { method: 'post' })
  }

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
      <Subheading level={2}>Flows</Subheading>
      <Text className="mt-1 text-sm">
        Each flow has a <code className="font-mono">Name</code>,{' '}
        <code className="font-mono">Weight</code> (relative probability), and{' '}
        <code className="font-mono">Queries</code> (Go templates). Weights are normalized
        automatically.
      </Text>

      <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        Template vars:{' '}
        {[
          '{{.UserID}}',
          '{{Name}}',
          '{{Email}}',
          '{{Word}}',
          '{{Sentence N}}',
          '{{UUID}}',
        ].map((t) => (
          <code key={t} className="mr-2 font-mono">
            {t}
          </code>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="mt-4 space-y-3">
        <textarea
          value={json}
          onChange={(e) => handleChange(e.target.value)}
          rows={16}
          spellCheck={false}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-900 dark:text-white"
        />
        {parseError && (
          <Text className="text-sm text-red-600 dark:text-red-400">{parseError}</Text>
        )}
        <div className="flex justify-end gap-3">
          <Button type="button" color="dark/zinc" onClick={handlePrettify}>
            Prettify
          </Button>
          <Button type="submit" color="dark/zinc" disabled={isSaving || !!parseError}>
            {isSaving ? 'Saving…' : 'Save Flows'}
          </Button>
        </div>
      </form>
    </div>
  )
}
