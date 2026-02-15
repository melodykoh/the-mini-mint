# Family Capital Ledger — Requirements

## Vision

A parent-administered, kid-viewable app that replaces the household chalkboard with a synthetic banking and investment platform. Kids learn compound interest, risk/reward, liquidity, stock valuation, and diversification — without real accounts, cards, or tax implications.

## Users

| Role | Who | Access |
|------|-----|--------|
| Admin | Melody + Husband | Full read/write, mobile-first |
| Viewer | Aiden (~6.5), Skylar (~4) | Read-only, shown on parent device |

Kids do not have their own devices. Parent shows them their "portfolio" on parent's phone/tablet.

## Money Sources (How Money Enters the System)

| Source | Example | Entry Method |
|--------|---------|-------------|
| Chores / tasks | "Read a story for Skylar" — $1 English, $3 Chinese | Parent manual entry |
| Hanzi Dojo points | 100 pts = $10 equivalent | Parent enters point balance, app converts |
| Red envelopes (CNY) | Variable cash gifts | Parent manual entry |
| Birthday / holiday gifts | Small amounts | Parent manual entry |
| Grandma's seed capital | ~$3,000 per kid (given years ago, has grown) | One-time seed at current estimated value |

### Hanzi Dojo Points Tracking
- Parent enters current Hanzi Dojo point total
- App converts at 100 pts = $10
- Tracks spend-down against that converted balance
- No direct API integration with Hanzi Dojo needed

## The Three Investment Products

### 1. Money Market Fund (MMF) — "Safe Savings"
- **Liquidity:** Fully liquid, withdraw anytime
- **Yield:** Variable, set by parent (mirrors real MMF rates, ~4-5% APY currently)
- **Accrual:** Daily calculation, visible on bank day or anytime
- **Teaching:** "Your money grows a little every day, safely"

### 2. Certificate of Deposit (CD) — "Locked Vault"
- **Liquidity:** Locked for chosen term
- **Terms:** 1 month / 3 months / 6 months (kid-appropriate durations)
- **Yield:** Higher than MMF, set by parent per term length
- **Early withdrawal:** Penalty (lose last month's interest — simple, memorable)
- **Maturity:** Funds return to cash balance; kid decides where to reinvest
- **Teaching:** "Lock it up longer = earn more. But you can't touch it."

### 3. Stock Picks — "My Companies"
- **Mechanic:** Virtual fractional shares
- **Purchase:** Kid picks a stock, parent approves, dollars convert to virtual shares at current price
- **Pricing:** Daily automated updates via stock price API
- **Sell:** Parent-approved, at current market price (gain or loss realized)
- **Limit:** TBD — suggest 3-5 stocks per kid initially
- **Teaching:** Volatility, company valuation, concentration risk, diversification

## Money Flow

```
Earnings / Gifts / Seed Capital
        ↓
   [Cash Balance] (uninvested, default landing zone)
        ↓
   Kid allocates (parent executes):
   ├── → MMF (liquid savings)
   ├── → CD (locked term)
   └── → Stock Pick (virtual shares)
        ↓
   Spend (parent-approved):
   ├── From Cash: immediate
   ├── From MMF: immediate ("sell" MMF units)
   ├── From Stock: at current price (realize gain/loss)
   └── From CD: only at maturity (or with penalty)
```

## Spending Rules
- All spending is parent-gated (no self-service for kids)
- Liquidity mirrors real-world constraints
- Selling stocks means accepting current price (gain or loss)
- CDs cannot be broken without penalty
- No minimum balance enforcement initially (revisit if needed)

## Key Views / Screens

### Admin Views (Melody + Husband)
1. **Dashboard** — Both kids' total balances at a glance
2. **Add Money** — Quick form: kid, amount, source, note
3. **Record Spend** — Kid, amount, from which bucket, what for
4. **Manage Investments** — Move money between cash/MMF/CD/stocks
5. **Bank Day** — Monthly review: update rates, process CD maturities, review performance
6. **Settings** — MMF rate, CD rates by term, stock pick limits

### Kid-Facing Views (shown on parent device)
1. **My Money** — Visual buckets showing:
   - Cash (spendable)
   - MMF balance + yield earned
   - CD vaults (with countdown to maturity)
   - Stock portfolio (current value, up/down indicators)
2. **Performance Chart** — Simple line chart showing total portfolio value over time
3. **My Stocks** — Individual holdings with price movement (green/red arrows)

## Teaching Moments (Design Goals)

| Concept | How the App Teaches It |
|---------|----------------------|
| Compound interest | MMF balance grows daily; "your money made money" |
| Risk vs. reward | Stock picks move more than MMF; compare side by side |
| Liquidity premium | CD earns more than MMF because it's locked |
| Time horizon | "You don't need this for 10 years — you can handle the ups and downs" |
| Stock valuation | "When you buy Nvidia, you're betting on their future" |
| Diversification | Compare single-stock volatility vs. VTI-like behavior |

## Technical Requirements

### Must Have
- Mobile-first responsive web app
- Auth for two admin users
- Daily stock price updates (automated via API)
- Transaction ledger (append-only, no manual balance editing)
- Computed balances (derived from transaction history)

### Nice to Have
- Performance charts (line chart, by bucket, over time)
- "Bank day" summary view
- Push notification on bank day reminder
- Dark mode (kids think it's cool)

### Explicitly Out of Scope (for now)
- Kid authentication / kid devices
- Real money movement
- Tax calculations (mentioned as future teaching moment)
- Hanzi Dojo API integration
- Allowance automation / recurring deposits

## Open Questions

- [ ] Exact grandma seed amount per kid and current estimated value
- [ ] How many stocks per kid? (Suggest 3-5 to start)
- [ ] CD term options — are 1/3/6 months right?
- [ ] Does uninvested cash earn anything, or only MMF does? (Suggest: cash = 0%, incentivizes allocating)
- [ ] Stock price API choice (free tier options: Yahoo Finance, Alpha Vantage, Polygon.io)
- [ ] Tech stack confirmation

## Proposed Data Model (Draft)

### kids
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| name | text | "Aiden", "Skylar" |
| created_at | timestamp | |

### transactions
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| kid_id | uuid | FK → kids |
| type | enum | deposit, withdraw, invest, redeem, interest, dividend, buy, sell |
| bucket | enum | cash, mmf, cd, stock |
| amount | decimal | Positive = in, negative = out |
| note | text | Optional description |
| metadata | jsonb | Flexible: { ticker, shares, price, cd_lot_id, source } |
| created_by | uuid | Which admin |
| created_at | timestamp | |

### cd_lots
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| kid_id | uuid | FK → kids |
| principal | decimal | Amount locked |
| apy | decimal | Rate at time of creation |
| term_months | int | 1, 3, or 6 |
| start_date | date | |
| maturity_date | date | Computed |
| status | enum | active, matured, broken |

### stock_positions
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| kid_id | uuid | FK → kids |
| ticker | text | e.g., "NVDA" |
| shares | decimal | Virtual fractional shares |
| cost_basis | decimal | Total dollars invested |

### stock_prices
| Column | Type | Notes |
|--------|------|-------|
| ticker | text | PK (composite) |
| date | date | PK (composite) |
| close_price | decimal | End-of-day price |

### settings
| Column | Type | Notes |
|--------|------|-------|
| key | text | PK — e.g., "mmf_apy", "cd_1m_apy" |
| value | text | The rate or config value |
| updated_at | timestamp | |

## Balances Are Always Computed

**Critical design rule:** There is no `balance` column anywhere. All balances are derived from the transaction ledger. This prevents drift and ensures auditability.

- **Cash balance** = SUM(transactions WHERE bucket='cash')
- **MMF balance** = SUM(transactions WHERE bucket='mmf') — includes interest credits
- **CD balance** = SUM(active cd_lots.principal) + accrued interest
- **Stock value** = SUM(position.shares * current_price) per ticker
- **Total portfolio** = cash + MMF + CD + stocks
