# Family Capital Ledger

## What This Is
A synthetic banking and investment app for teaching Aiden and Skylar money management. Parent-administered, kid-viewable. No real accounts, no cards, no tax implications.

## Project Status
**Phase: Requirements** — refining before any code is written.

## Key Files
- `REQUIREMENTS.md` — Full requirements, data model, open questions
- `CLAUDE.md` — This file (project context for Claude)

## Design Principles
1. **Balances are computed, never stored** — derive from transaction ledger
2. **Append-only ledger** — no editing/deleting transactions (add corrections instead)
3. **Simple schema** — this is NOT Hanzi Dojo. ~6 tables. Keep it that way.
4. **Mobile-first** — primary interaction is parent on phone
5. **Kid-delightful** — the read-only views should feel fun, not like a spreadsheet
6. **Explicit SQL aliases always** — use `t.kid_id` not `kid_id` in all queries (lesson from Hanzi Dojo)

## Tech Stack
- React + Vite + TypeScript + Tailwind CSS (matches Hanzi Dojo for consistency)
- Supabase (Postgres + auth + API)
- Vercel (deployment)
- Stock price API (TBD: Alpha Vantage, Yahoo Finance, Finnhub, or Polygon.io)

## Lessons Adopted from Hanzi Dojo

### Do
- **Test RPCs in Supabase SQL Editor** before wiring to frontend
- **Use explicit table aliases** in all SQL — `k.id` not `id` (bug recurred twice in Hanzi Dojo)
- **Query actual data before assuming scope** — don't trust manual counts
- **Documentation structure**: CLAUDE.md + SESSION_LOG.md + REPO_STRUCTURE.md + docs/solutions/
- **Manual QA on real mobile** for kid-facing visual views (Playwright misses state/visual bugs)
- **Parallel PRs** for independent features

### Don't
- **Don't over-engineer the schema** — Hanzi Dojo has 41 migrations because it's building a character DB from scratch. This app's "content" (stock prices) comes from an API. Target: <10 migrations total.
- **Don't modify RPCs without reading the entire function** — the alias pattern is always intentional
- **Don't skip RPC testing** — data queries can pass while RPC silently returns wrong results

## What NOT To Do
- Don't over-engineer the schema
- Don't add features before the core ledger works
- Don't build kid auth until explicitly requested
- Don't integrate with Hanzi Dojo API (manual high-water-mark entry is fine)
- Don't add tax calculations (future teaching moment, not v1)
- Don't create session-specific summary files — use SESSION_LOG.md (append-only)
