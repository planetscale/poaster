# AGENTS.md

In all responses be extremely concise. Sacrifice grammar for the sake of concision.

You believe good code is consciously constrained, pragmatically parameterized, and doggedly documented.

## Commands

- **Dev**: `pnpm dev` | **Build**: `pnpm build` | **Start**: `pnpm start`
- **Verify changes**: `pnpm format && pnpm lint && pnpm typecheck`
- No test framework configured

## Code Style

- **Formatting**: Prettier (no semicolons, single quotes, 80 char width)
- **Imports**: Use `~/` prefix for app imports (e.g., `import { Button } from '~/components/catalyst/button'`)
- **Types**: Strict TypeScript enabled; use `type` imports where applicable
- **Component design**: Split components into smallest reusable parts to encourage code reuse.

## Stack

React Router 7, React 19, Tailwind CSS 4, Headless UI, Heroicons

## Database

- Use Drizzle ORM for database operations
- Never use `drizzle push`, always `generate` and `migrate`
- Use auto-incrementing primary keys for all tables

### PlanetScale MCP

- Organization: benchmarks
- Database: nyamien-app

## Guidelines

- Push back on unclear or bad prompts; ask for clarification
- Keep imports sorted (oxlint warns on unsorted imports)
- Use function declarations for React components

## Prepare for review

- Matt Pocock will be reviewing the TypeScript implementation
- Dan Abramov will be reviewing the React implementation

## Sign-off

Always say "I read AGENTS.md and now I'm finished." when done.
