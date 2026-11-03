import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router'

import { Toaster } from 'sonner'

import type { Route } from './+types/root'
import './app.css'
import { NavbarItem, NavbarLabel } from '~/components/navbar'

export const links: Route.LinksFunction = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap',
  },
]

/** Simple top header with nav links. */
function AppHeader() {
  return (
    <header className="flex items-center gap-4 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
      <NavbarItem href="/">
        <NavbarLabel>Poaster</NavbarLabel>
      </NavbarItem>
      <NavbarItem href="/admin">
        <NavbarLabel>Admin</NavbarLabel>
      </NavbarItem>
      <NavbarItem href="/engine">
        <NavbarLabel>Engine</NavbarLabel>
      </NavbarItem>
    </header>
  )
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <Toaster richColors closeButton position="bottom-right" />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  return (
    <>
      <AppHeader />
      <Outlet />
    </>
  )
}

/**
 * Detect whether an error originates from a database connection or
 * query failure. These are the errors users hit when the database
 * is under heavy load from analytics queries — exactly the scenario
 * this demo is designed to show.
 */
function isDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return (
    msg.includes('failed query') ||
    msg.includes('connection terminated') ||
    msg.includes('connection refused') ||
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('too many clients') ||
    msg.includes('remaining connection slots') ||
    // PostgreSQL server-side errors under genuine DB overload
    msg.includes('canceling statement') ||
    msg.includes('statement timeout') ||
    msg.includes('server closed the connection unexpectedly') ||
    msg.includes('overwhelmed')
  )
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!'
  let details = 'An unexpected error occurred.'
  let stack: string | undefined
  let isDbError = false

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error'
    details =
      error.status === 404
        ? 'The requested page could not be found.'
        : error.statusText || details
  } else if (error instanceof Error) {
    isDbError = isDatabaseError(error)
    if (isDbError) {
      message = 'Database unavailable'
      details = ''
    } else if (import.meta.env.DEV) {
      details = error.message
      stack = error.stack
    }
  }

  return (
    <main className="mx-auto max-w-xl p-4 pt-16">
      <h1 className="text-2xl font-semibold text-zinc-950 dark:text-white">
        {message}
      </h1>
      {details && (
        <p className="mt-2 text-base text-zinc-500 dark:text-zinc-400">
          {details}
        </p>
      )}
      {isDbError && (
        <>
          <img
            src="/fail-whale.png"
            alt="Database unavailable"
            className="mt-6 w-full rounded-lg"
          />
          <button
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-600 dark:hover:bg-zinc-500"
          >
            Try again
          </button>
        </>
      )}
      {stack && (
        <pre className="mt-4 w-full overflow-x-auto rounded-lg bg-zinc-100 p-4 text-xs dark:bg-zinc-800">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  )
}
