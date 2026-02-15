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
3. **Simple schema** — this is NOT Hanzi Dojo. ~5 tables. Keep it that way.
4. **Mobile-first** — primary interaction is parent on phone
5. **Kid-delightful** — the read-only views should feel fun, not like a spreadsheet

## Tech Stack
TBD — to be confirmed with Melody. Likely candidates:
- Next.js (mobile-first web app)
- Supabase (Postgres + auth + API)
- Stock price API (Alpha Vantage, Yahoo Finance, or Polygon.io)

## What NOT To Do
- Don't over-engineer the schema
- Don't add features before the core ledger works
- Don't build kid auth until explicitly requested
- Don't integrate with Hanzi Dojo (manual entry is fine)
- Don't add tax calculations (future teaching moment, not v1)
