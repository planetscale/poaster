import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

import { postgresUrlForNode } from './app/db/postgres-url'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}

export default defineConfig({
  out: './drizzle',
  schema: './app/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: postgresUrlForNode(process.env.DATABASE_URL),
    ssl: { rejectUnauthorized: true },
  },
})
