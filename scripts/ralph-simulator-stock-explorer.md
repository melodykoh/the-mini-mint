# Ralph Prompt: Simulator Stock Explorer

## Context

You are working on The Mini Mint (TMM), a family banking app. Read `CLAUDE.md` for full project context.

This task adds a "stock explorer" feature to the Simulator page so parents can look up ANY ticker and see historical performance projections before deciding to buy.

**Why:** Today the Simulator only shows stocks the kid already owns. The real workflow is: Aiden says "I want to buy Nvidia" → parent looks up NVDA in the Simulator → they discuss best/worst case returns → THEN they decide whether to buy.

**GitHub Issues:** This resolves #2 (stock simulation not working) and #3 (unclear how to add price data for new stocks).

---

## Files to Read First (MANDATORY)

Read these files completely before making any changes:

1. `src/pages/Simulator.tsx` — the page you're modifying
2. `src/lib/simulator.ts` — simulation math (rolling window best/worst logic). DO NOT change the math. It already works correctly.
3. `src/lib/stock-prices.ts` — has `backfillStockHistory()`, `getTrackedTickers()`, `refreshStockPrices()`
4. `src/components/Layout.tsx` — nav structure
5. `src/pages/Invest.tsx` — understand the stock buy flow and existing patterns (useActionFlow, ConfirmAction, etc.)
6. `src/lib/format.ts` — formatting helpers
7. `src/lib/supabase.ts` — Supabase client

---

## Exact Behavior to Implement

### 1. Add Ticker Input to Simulator Page

In `src/pages/Simulator.tsx`, add a new section **below** the Fixed Income section (keep current layout order: fixed income first, then stocks).

The section should have:
- A heading: "Explore a Stock"
- A text input for the ticker symbol (uppercase, max 10 chars)
- A "Look Up" button
- The input should auto-uppercase whatever the user types

### 2. Auto-Backfill Price Data

When the user submits a ticker:

1. Check if `stock_prices` has data for that ticker (query Supabase: `SELECT count(*) FROM stock_prices WHERE ticker = $ticker`)
2. If **no data exists**: call `backfillStockHistory([ticker])` from `src/lib/stock-prices.ts`
   - Show a loading state: "Fetching price history for {TICKER}..." with a spinner or pulsing animation
   - This calls the `fetch-stock-prices` Supabase Edge Function in `backfill` mode
3. If data already exists: skip straight to displaying results
4. Handle errors:
   - Invalid ticker (backfill returns empty/error): show "Couldn't find price data for {TICKER}. Check the ticker symbol."
   - Network/rate limit error: show "Price data service is busy. Wait a moment and try again."

### 3. Performance Summary Card

After data loads, show a performance summary card for the ticker:

- **YTD return**: latest price vs. price on Jan 1 of current year
- **Last 12 months**: latest price vs. price 12 months ago
- **Last 5 years**: latest price vs. price 5 years ago

Calculate these from the `stock_prices` table. Use the existing `supabase` client and query pattern from `simulator.ts`. Use `findClosestDateIndex` logic or similar for date matching.

Format: show each as a percentage with color coding (green for positive, red for negative, gray for zero). Use the existing `gainColor()` helper pattern already in `Simulator.tsx`.

If insufficient data for a period (e.g., stock is only 2 years old), show "N/A" for 5yr.

### 4. Simulation Results (Best / Worst / Actual)

Below the performance summary, show the existing simulation results. This uses the already-working `getHistoricalStockReturns()` function from `simulator.ts`.

Display format (already exists in the current code for owned stocks):
- Three columns: Worst case | Actual (last N months) | Best case
- Each shows: dollar amount, percentage, date range
- Use the same card styling that currently exists for stock results in `Simulator.tsx` lines 159-215

Add a kid-friendly plain-English summary below the cards:
```
"In the worst {N}-month stretch, your ${amount} would have become ${worst}.
 In the best {N}-month stretch, it could have become ${best}."
```

### 5. "Buy for [Kid]" Links

Below the simulation results, show a link for each kid:
- Query kids from Supabase: `SELECT id, name FROM kids ORDER BY name`
- Render as buttons/links: "Buy {TICKER} for {Kid Name}"
- Each links to `/kid/{kidId}/invest`
- Filter out kids whose names start with "QA-" (test accounts) — unless you detect the test user is logged in (check if user email matches the pattern in `.env.test.local`). Actually, simpler: just filter out "QA-" prefixed kids always. The QA user can still navigate to invest manually.

### 6. Reactivity: Horizon and Amount Changes

When the user changes the time horizon pills or the amount input:
- Fixed income projections recalculate (already works)
- The explored stock simulation recalculates with the new horizon/amount
- The performance summary (YTD/1yr/5yr) does NOT change (it's always actual historical, not tied to selected horizon)

### 7. Existing Stocks Section

Keep the existing "Stocks" section that shows already-owned tickers below the explorer. Rename its heading to "Your Stocks" to differentiate from the explorer section.

If no tickers are owned, don't show this section (current behavior).

---

## What NOT to Change

- `src/lib/simulator.ts` — the math is correct, do not modify
- `src/lib/stock-prices.ts` — the backfill function works, do not modify
- The `supabase/functions/fetch-stock-prices/` edge function — do not modify
- Fixed income section layout or logic
- Any other pages (Dashboard, Invest, Settings, etc.)
- Navigation structure in Layout.tsx

---

## Technical Constraints

- Use `@tanstack/react-query` for all data fetching (match existing patterns in `Simulator.tsx`)
- Use Tailwind CSS classes (match existing design patterns)
- Do not install new dependencies
- Use `instanceof Error` check sparingly — Supabase errors are plain objects. Use pattern from `src/lib/errors.ts` if it exists, otherwise check for `error.message` property.
- Use explicit table aliases in any SQL (per project CLAUDE.md)

---

## Machine-Verifiable Acceptance Criteria

1. `npx tsc --noEmit` passes (no TypeScript errors)
2. `npm run build` succeeds (no build errors)
3. Dev server runs without console errors on the Simulator page

---

## QA Scenarios (Execute ALL via Playwright MCP)

Start the dev server (`npm run dev`) and verify each scenario at `http://localhost:5173/simulator`.

**Login first:** Use credentials from `.env.test.local` (testuser@familyapps.com).

### Core Flow
- [ ] Q1: Enter ticker with NO existing price data (e.g., "MSFT" if not already in stock_prices) → loading state appears → backfill runs → simulation displays with best/worst/actual
- [ ] Q2: Enter ticker that ALREADY has price data → simulation displays immediately without backfill loading
- [ ] Q3: Change time horizon (1yr → 3yr) after lookup → stock simulation results update (amounts and date ranges change)
- [ ] Q4: Change amount ($100 → $500) after lookup → all projections recalculate (fixed income AND stock)
- [ ] Q5: Performance summary shows YTD, Last 12mo, Last 5yr percentages with correct color coding

### Buy Links
- [ ] Q6: "Buy {TICKER} for {Kid}" links appear for each non-QA kid
- [ ] Q7: Clicking a buy link navigates to the correct `/kid/:kidId/invest` page

### Error Handling
- [ ] Q8: Invalid ticker (e.g., "XYZZY") → clear error message, page doesn't crash
- [ ] Q9: Empty ticker input → Look Up button is disabled or does nothing
- [ ] Q10: Ticker with short history + long horizon (e.g., 2yr old stock + 5yr horizon) → graceful message

### Existing Functionality Preserved
- [ ] Q11: Fixed income section still displays correctly (cash, MMF, CDs with correct amounts)
- [ ] Q12: Already-owned tickers still display under "Your Stocks" section
- [ ] Q13: Horizon pills and amount input work for fixed income as before

### Mobile Responsiveness
- [ ] Q14: At mobile viewport (390×844, iPhone 14) — ticker input and Look Up button are usable, not clipped or overflowing
- [ ] Q15: At mobile viewport — best/worst/actual three-column layout is readable (columns don't overlap or truncate dollar amounts)
- [ ] Q16: At mobile viewport — performance summary (YTD/1yr/5yr) is readable, not cut off
- [ ] Q17: At mobile viewport — "Buy for [Kid]" buttons are tappable (min 44px touch target) and don't overflow
- [ ] Q18: At mobile viewport — horizon pills don't overflow off screen (they should scroll or wrap)

### Edge Cases
- [ ] Q19: Lowercase ticker input (types "nvda") → treated as "NVDA"
- [ ] Q20: Amount of $0 → stock explorer section doesn't show broken results
- [ ] Q21: Very large amount ($99,999) → formatting doesn't break

### Post-QA Cleanup
- [ ] Q22: Delete any screenshots or `.playwright-mcp/` artifacts created during verification

---

## Completion Signal

After ALL QA scenarios pass:
1. Commit all changes with message: "Add stock explorer to Simulator page\n\nCloses #2, closes #3"
2. Output: SIMULATOR STOCK EXPLORER COMPLETE
