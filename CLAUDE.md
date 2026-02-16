# The Mini Mint

## What This Is
A synthetic banking and investment app for teaching Aiden and Skylar money management. Parent-administered, kid-viewable. No real accounts, no cards, no tax implications.

## Project Status
**Phase: Phase A (The Engine)** — backend RPCs + admin UI complete, smoke testing in progress.

## Key Files
- `REQUIREMENTS.md` — Full requirements, data model, open questions
- `PHASE_A_PLAN.md` — The Engine: 16-task execution plan for backend + admin UI
- `LEARNINGS_APPLIED.md` — Hanzi Dojo learnings applied to this project
- `CLAUDE.md` — This file (project context for Claude)

## Design Principles
1. **Balances are computed, never stored** — derive from transaction ledger
2. **Append-only ledger** — no editing/deleting transactions (add corrections instead)
3. **Simple schema** — this is NOT Hanzi Dojo. 7 tables. Keep it that way.
4. **Mobile-first** — primary interaction is parent on phone
5. **Kid-delightful** — the read-only views should feel fun, not like a spreadsheet
6. **Explicit SQL aliases always** — use `t.kid_id` not `kid_id` in all queries (lesson from Hanzi Dojo)

## Tech Stack
- React + Vite + TypeScript + Tailwind CSS (matches Hanzi Dojo for consistency)
- Supabase (Postgres + auth + API) — **shared with Lego App project** (see below)
- Vercel (deployment)
- Stock price API: **Twelve Data** (free tier, 800 calls/day, batch endpoint). Fallback: Polygon.io

## Shared Supabase Project (IMPORTANT)

**TMM shares the Lego App's Supabase project.** This is documented in both repos.

**Why:** Supabase free tier allows only 2 projects (Hanzi Dojo + Lego App). Hanzi Dojo was ruled out: `kids` table name conflict, signups must stay enabled (other families use it), 47+ active migrations create collision risk. Lego App has 2 tables (`creations`, `photos`), zero conflicts, and benefits from TMM keeping the project active.

**Implications for TMM development:**
- Supabase credentials (URL, anon key, service role key) are the same as Lego App's
- Auth users are shared — Melody's account works for both apps
- **Never drop or modify** Lego App tables (`creations`, `photos`)
- Migrations must be applied carefully — this project has other tables
- Signups are disabled at project level (P4b prerequisite)

**Lego App repo:** `/Users/melodykoh/Documents/Claude Projects/Personal/Aiden's Lego Site/`

## Lessons Adopted from Hanzi Dojo

### Do
- **Test RPCs in Supabase SQL Editor** before wiring to frontend
- **Use explicit table aliases** in all SQL — `k.id` not `id` (bug recurred twice in Hanzi Dojo)
- **Query actual data before assuming scope** — don't trust manual counts
- **Documentation structure**: CLAUDE.md + SESSION_LOG.md + REPO_STRUCTURE.md + docs/solutions/
- **QA with Playwright MCP + Agent Browser** for frontend verification (see QA Strategy below)
- **Parallel PRs** for independent features

### Don't
- **Don't over-engineer the schema** — Hanzi Dojo has 41 migrations because it's building a character DB from scratch. This app's "content" (stock prices) comes from an API. Target: <10 migrations total.
- **Don't modify RPCs without reading the entire function** — the alias pattern is always intentional
- **Don't skip RPC testing** — data queries can pass while RPC silently returns wrong results
- **Don't write ad-hoc SQL from memory** — always verify column names, trigger names, and table structure against `001_initial_schema.sql` before giving SQL to run. Three errors in a row (wrong column name, wrong trigger name, wrong trigger name again) is unacceptable. Read the schema first, write the SQL second.
- **Don't use `instanceof Error` for Supabase errors** — PostgrestError is a plain object, not an Error subclass. Use `extractErrorMessage()` from `src/lib/errors.ts`.
- **Don't design RPCs without considering UI display needs** — ask "what does the UI need to show?" before writing the RPC. If the display needs context beyond core fields, add a metadata parameter from day one.
- **Don't use `?? 'fallback'` for loading states** — `kids?.find()?.name ?? 'Unknown'` conflates "loading" with "missing." Check `isLoading` → show skeleton. Text fallbacks only for genuinely absent data.
- **Don't forget secondary query invalidation** — after mutations, grep for ALL `useQuery` keys related to the mutated entity, not just the primary one.

## QA Strategy

### Tooling (Updated from Hanzi Dojo Lessons)

Hanzi Dojo (Sessions 1-25) relied on Playwright MCP alone, which missed visual/state bugs.
This project uses two complementary tools:

| Tool | What It's Good At | When to Use |
|------|-------------------|-------------|
| **Playwright MCP** | Accessibility snapshots, element presence, functional flows, form submission | Unit-level UI verification, navigation, data display correctness |
| **Agent Browser** (Vercel) | Visual rendering, authenticated views, real browser behavior, screenshot comparison | Visual QA, mobile viewport testing, design fidelity, end-to-end flows |

### QA Protocol
1. **Backend/RPC**: Test in Supabase SQL Editor first (before any frontend wiring)
2. **Functional UI**: Playwright MCP — does the right data show up? Do forms work?
3. **Visual UI**: Agent Browser — does it look right? Mobile layout correct? Charts render?
4. **Kid experience**: Manual (show Aiden) — does it feel fun? Is it confusing?

**Note:** Agent Browser requires a dev session running in terminal (`npx agent-browser`).

## What NOT To Do
- Don't over-engineer the schema
- Don't add features before the core ledger works
- Don't build kid auth until explicitly requested
- Don't integrate with Hanzi Dojo API (manual high-water-mark entry is fine)
- Don't add tax calculations (future teaching moment, not v1)
- Don't create session-specific summary files — use SESSION_LOG.md (append-only)
