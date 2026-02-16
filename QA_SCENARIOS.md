# QA Scenarios — Phase A Smoke Test

**Test subject:** TestKid (all tests use TestKid, never Aiden/Skylar)
**Starting state:** All balances $0.00
**Tool:** Playwright MCP (functional verification)

---

## 1. Dashboard

- [ ] **1.1** Dashboard loads with 3 kids: Aiden, Skylar, TestKid
- [ ] **1.2** All buckets show $0.00 for TestKid
- [ ] **1.3** Invest / Add Money / Spend action links visible per kid
- [ ] **1.4** Invest link goes to correct kid URL (`/kid/:kidId/invest`)

## 2. Add Money (Deposit)

### Happy paths
- [ ] **2.1** Deposit $100 to TestKid (source: Chores) → success, balance = $100
- [ ] **2.2** Deposit $50 to TestKid (source: Gift) → success, balance = $150
- [ ] **2.3** Dashboard reflects TestKid Cash = $150.00

### Hanzi Dojo Points flow (real-world: parent reads points from Hanzi Dojo dashboard)
- [ ] **2.4** Select "Hanzi Dojo Points" → form switches to points input mode
- [ ] **2.5** Shows "First entry" message (no prior snapshot)
- [ ] **2.6** Enter 500 points → app computes: 500 × $0.10 = $50.00 deposit shown
- [ ] **2.7** Submit → success, cash balance increases by $50.00
- [ ] **2.8** Select Hanzi Dojo again → now shows "Last recorded: 500 points"
- [ ] **2.9** Enter 658 → shows "158 new points × $0.10 = $15.80" deposit
- [ ] **2.10** Enter 400 (less than 500) → warning: "fewer points than last time"
- [ ] **2.11** Enter 500 (same as last) → "No new points since last entry"

### Validation guards
- [ ] **2.12** Submit disabled with no kid selected
- [ ] **2.13** Submit disabled with no source selected

## 3. Invest — MMF (real-world: "safe savings" that grows daily)

- [ ] **3.1** Navigate to TestKid invest page → shows correct name, available cash
- [ ] **3.2** Invest $60 into MMF → cash drops to $140, MMF = $60
- [ ] **3.3** Redeem $20 from MMF → cash = $160, MMF = $40
- [ ] **3.4** Invest more than available cash → error: "Insufficient cash"
- [ ] **3.5** Redeem more than MMF balance → error: "Insufficient MMF balance"
- [ ] **3.6** MMF APY rate displays correctly (from settings, e.g., 4.2%)

## 4. Invest — CD (real-world: "locked vault" with higher return)

- [ ] **4.1** Create 3-month CD for $30 → cash decreases by $30, CD lot appears
- [ ] **4.2** CD lot shows: principal, term, APY, maturity date, days remaining
- [ ] **4.3** "Break Early" button visible on active CD (CD hasn't matured yet)
- [ ] **4.4** Break CD → cash increases (principal returned, net never less than principal)
- [ ] **4.5** CD disappears from active list after break
- [ ] **4.6** Term selector: 3mo / 6mo / 12mo pills work correctly
- [ ] **4.7** Create CD with more than available cash → error: "Insufficient cash"

## 5. Invest — Stocks (real-world: "my investments" with real companies)

*Stock operations require price data in the `stock_prices` table.*

### Without price data
- [ ] **5.1** Buy stock with no price data → error: "No price data for ticker"

### With price data (after refresh or manual seed)
- [ ] **5.2** Buy $20 of a tracked stock → cash decreases, position appears with shares + cost basis
- [ ] **5.3** Position shows: ticker, shares, cost basis, current value, gain/loss $ and %
- [ ] **5.4** Partial sell → cash increases, shares/cost_basis reduce proportionally
- [ ] **5.5** "Sell All" → position removed entirely, full proceeds to cash
- [ ] **5.6** Buy with insufficient cash → error
- [ ] **5.7** Position count display (e.g., "1 of 5 positions")
- [ ] **5.8** Ticker input only accepts uppercase letters

## 6. Spend (real-world: kid buys Pokemon cards, ice cream, toy)

### From Cash
- [ ] **6.1** Spend $10 from Cash (note: "Ice cream") → success, cash decreases by $10
- [ ] **6.2** Note field is required → button disabled without note

### From MMF (3-step atomic: redeem → credit cash → withdraw cash)
- [ ] **6.3** Spend $10 from MMF → MMF decreases by $10, cash stays same (net zero on cash)
- [ ] **6.4** Spend more than MMF balance → error: "Insufficient MMF balance"

### From Stock
- [ ] **6.5** (if stock position exists) Spend from stock → stock position reduces, cash unchanged
- [ ] **6.6** Shows realized gain/loss in success message

### Validation
- [ ] **6.7** Spend more than cash balance (from Cash source) → error: "Insufficient cash"
- [ ] **6.8** CD is NOT available as a spend source (it's locked)

## 7. Settings (real-world: parent adjusts rates on "bank day")

- [ ] **7.1** All 6 settings load: MMF APY, 3 CD APYs, position limit, Hanzi rate
- [ ] **7.2** Values display correctly (e.g., 4.2% not 0.042)
- [ ] **7.3** Edit MMF APY → save → success message
- [ ] **7.4** Reload page → saved value persists
- [ ] **7.5** "Refresh Stock Prices" button → calls edge function → shows result
- [ ] **7.6** "Accrue MMF Interest" button → accrues for all kids with MMF balance → shows per-kid results
- [ ] **7.7** Last-updated timestamps visible per setting

## 8. Simulator (real-world: dinner table "what would my money become?")

- [ ] **8.1** Page loads at `/simulator` with default $100
- [ ] **8.2** Fixed income results: Cash ($100, no growth), MMF, CD 3mo, CD 6mo, CD 12mo
- [ ] **8.3** Time horizon pills (3mo, 6mo, 1yr, 3yr, 5yr) change results
- [ ] **8.4** CD terms that don't fit horizon are excluded (e.g., no CD 12m for 6mo horizon)
- [ ] **8.5** Stock section: shows "Loading..." or "insufficient history" or actual results
- [ ] **8.6** Stock results labeled "Based on past performance — not guaranteed"

## 9. Cross-Cutting Verification

### Balance integrity (the most critical check)
- [ ] **9.1** Return to dashboard → TestKid totals match sum of all bucket balances
- [ ] **9.2** Aiden and Skylar still show $0.00 (untouched by all tests)

### Auth & security
- [ ] **9.3** Sign out → redirected to login
- [ ] **9.4** Navigate to `/` while signed out → redirected to login

### Navigation
- [ ] **9.5** All nav links work: Dashboard, Add Money, Spend, Simulator, Settings
- [ ] **9.6** "Back" link on invest page returns to dashboard

## 10. Invest Page Bug Check

*Noticed during initial testing — may be timing/data issue:*

- [ ] **10.1** Invest page shows kid's name (not "Unknown")
- [ ] **10.2** Invest page shows correct "Available to invest" amount (not $0.00)

---

## Running This QA

Execute scenarios in order — TestKid accumulates state across scenarios.

**Expected final TestKid state** (approximate, depends on exact test amounts):
- Cash: $150 - deposits and withdrawals across all test scenarios
- MMF: whatever remains after invest/redeem/spend tests
- CDs: should be empty (broken in S4)
- Stocks: depends on whether price data was available

**Phase A Definition of Done requires:** complete lifecycle from deposit → invest in all 3 products → accrue interest → spend → verify balances.
