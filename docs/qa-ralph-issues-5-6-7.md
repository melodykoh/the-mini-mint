# QA Scenarios: Issues #5, #6, #7

Executed: 2026-02-16 via Playwright MCP on localhost:5173

## Issue #5: Pre-select kid when navigating from Dashboard

### Happy Paths

- **5.1** PASS — Click "Add Money" on Aiden's card → Aiden pre-selected (blue pill, URL has ?kid=uuid)
- **5.2** PASS — Click "Spend" on QA-Alice's card → QA-Alice pre-selected, balances loaded ($374.50 cash)

### Preserved Behavior

- **5.4** PASS — Navigate to /add-money via header nav → no kid selected, helper text "Select a kid and a source"
- **5.5** PASS — Navigate to /spend via header nav → no kid selected, helper text "Select a kid and describe..."
- **5.6** PASS — "Invest" links use /kid/:kidId/invest route params (unchanged)
- **5.7** PASS — "History" links use /kid/:kidId/history route params (unchanged)

### Edge Cases

- **5.8** PASS — /add-money?kid=bogus-uuid → page renders, no kid highlighted, no crash, Deposit disabled

---

## Issue #6: Hide/show test kids toggle in Settings

### Happy Paths

- **6.1** PASS — "Show test kids" checkbox appears under "Display" section in Settings
- **6.2** PASS — Checkbox defaults to ON (checked)
- **6.3** PASS — Toggle OFF → Dashboard shows only Aiden + Skylar (QA-Alice, QA-Bob, TestKid hidden)
- **6.4** PASS — Toggle back ON → Dashboard shows all 5 kids again

### Persistence

- **6.5** PASS — Toggle OFF → full page reload Settings → checkbox remains unchecked (localStorage)

### Non-Interference

- **6.7** PASS — Toggle OFF → Add Money kid selector shows ALL 5 kids (filter is Dashboard-only)
- **6.9** PASS — Toggle OFF → direct URL /kid/[QA-Alice-ID]/invest → Invest page works, full portfolio visible

---

## Issue #7: Show APY under CD duration options on Invest page

### Happy Paths

- **7.1** PASS — CD section shows three term buttons: "3mo", "6mo", "12mo"
- **7.2** PASS — Each button includes APY: "3mo — 4.8%", "6mo — 5.0%", "12mo — 5.2%"
- **7.3** PASS — APY values match Settings page exactly (verified: 4.8%, 5.0%, 5.2%)

### Visual

- Screenshot confirmed: term pills are clear and readable, selected term in amber, unselected in gray

---

## Summary

| Issue | Scenarios | Passed | Failed |
|-------|-----------|--------|--------|
| #5 Pre-select kid | 7 | 7 | 0 |
| #6 Test kids toggle | 7 | 7 | 0 |
| #7 CD APY display | 3 | 3 | 0 |
| **Total** | **17** | **17** | **0** |

TypeScript: compiles clean (npx tsc --noEmit)
