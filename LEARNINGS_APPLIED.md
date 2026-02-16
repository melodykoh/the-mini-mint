# The Mini Mint: Learnings Applied from Hanzi Dojo

**Date:** 2026-02-15
**Scope:** Analysis of all 6 learning documents from Hanzi Dojo and their applicability to The Mini Mint Phase A Plan

---

## Executive Summary

**Highly Relevant Learnings:** 3 out of 6 documents directly apply to this project.

| Learning Document | Relevant? | Impact on Phase A |
|-------------------|-----------|------------------|
| PL/pgSQL Ambiguous Column Reference | **CRITICAL** | RPC functions must use explicit aliases (already noted in PHASE_A_PLAN.md) |
| Incomplete Data Fix Scope Discovery | **HIGH** | Migration scope discovery pattern; query data before writing fixes |
| Migration Regression Pattern | **HIGH** | Must review migration history before modifying existing functions |
| Simplified Context Words Filtering Issue | **MEDIUM** | Data inheritance patterns; data flow validation critical |
| Drill C QA Learnings | **LOW** | QA tooling/process relevant (Playwright limitations); drill features not in Phase A |
| Solutions Directory README | **REFERENCE** | Template for documenting future bugs/gotchas in this project |

---

## 1. PL/pgSQL Ambiguous Column Reference (CRITICAL)

**File:** `docs/solutions/database-issues/plpgsql-ambiguous-column-reference.md`

**Problem:** RETURNS TABLE creates OUT parameters that conflict with bare column names in WHERE clauses. Bug was introduced twice in Hanzi Dojo (Issue #40, reappeared in issue #42).

**Why It's Critical for TMM:**
- Phase A has **8 PL/pgSQL RPCs** that use RETURNS TABLE (T4-T8, T14 spend functions)
- **All write operations must be atomic** — RPC failures cascade to frontend
- The bug is **silent** — queries run but return wrong results without obvious error

### Application to Phase A Plan

**Affected Tasks:**
- T4: `deposit_to_cash`, `withdraw_from_cash` with `IF NOT EXISTS (SELECT 1 FROM kids WHERE id = ...)`
- T5: `invest_in_mmf`, `redeem_from_mmf`, `accrue_mmf_interest`
- T6: `create_cd`, `break_cd`, `mature_cd`
- T7: `buy_stock`, `sell_stock`
- T8: `record_hanzi_dojo_points`
- T14: `spend_from_mmf`, `spend_from_stock`

**Prevention Steps (Add to Phase A Plan):**

```markdown
### SQL RPC Development Checklist (All Tasks T4-T8, T14)

**Before writing RPC functions:**
- [ ] Use explicit table aliases in ALL queries (t.kid_id, k.id, not bare id)
- [ ] Use explicit column aliases in SELECT (wp.id AS id)
- [ ] Test directly in Supabase SQL Editor with real IDs before wiring to frontend
- [ ] Pattern: If RETURNS TABLE has OUT param named X, never write bare X in WHERE/SELECT

**Code pattern to follow:**
```sql
CREATE FUNCTION deposit_to_cash(p_kid_id uuid, p_amount numeric, ...)
RETURNS TABLE (new_balance numeric) AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kids k  -- ← Explicit alias
    WHERE k.id = p_kid_id -- ← Use alias, not bare 'id'
    AND k.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Unauthorized...';
  END IF;

  -- Always alias columns in SELECT
  RETURN QUERY
  SELECT SUM(t.amount) AS new_balance  -- ← Alias here
  FROM transactions t
  WHERE t.kid_id = p_kid_id
  AND t.bucket = 'cash';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
```

**Verification:**
- [ ] Syntax check: `CREATE OR REPLACE FUNCTION ...` in SQL Editor
- [ ] Functional test: `SELECT * FROM function_name('uuid') LIMIT 1;` with real IDs
- [ ] No "ambiguous column" errors
```

---

## 2. Incomplete Data Fix Scope Discovery (HIGH)

**File:** `docs/solutions/database-issues/incomplete-data-fix-scope-discovery-20251215.md`

**Problem:** Initial investigation found 11 affected records; actual scope was 68 (6x undercount). Root cause: trusted documentation instead of querying actual data.

**Why It Matters for TMM:**
- Phase A includes **seed data** (kids, settings with hardcoded rates)
- Future migrations will need to **validate data integrity** (transactions balance per kid, no orphaned positions)
- **Data assumptions** (e.g., "we'll never have > 5 stock positions per kid") need verification before writing constraints

### Application to Phase A Plan

**Add to Migration Development Workflow:**

```markdown
### Data Validation Pattern (Before Writing Migration Fixes)

**Rule: Query actual data before writing migration constraints**

Example: Before adding CHECK constraints on stock positions:

```sql
-- Step 1: Query current state to find violations
SELECT kid_id, ticker, COUNT(*) as position_count
FROM stock_positions
GROUP BY kid_id, ticker
HAVING COUNT(*) > 1;  -- Should return 0 rows

-- Step 2: Verify assumed uniqueness holds
SELECT kid_id, COUNT(DISTINCT ticker) as ticker_count
FROM stock_positions
GROUP BY kid_id
HAVING COUNT(DISTINCT ticker) > 5;  -- Should return 0 rows (position limit)

-- Step 3: Only then add constraint
ALTER TABLE stock_positions
ADD CONSTRAINT unique_per_kid_per_ticker
UNIQUE (kid_id, ticker);
```

**Documentation requirement:**
- Every migration that adds a constraint must include a verification query BEFORE the constraint
- If query returns unexpected rows, migration fails (intentional — stops incomplete thinking)
```

---

## 3. Migration Regression Pattern (HIGH)

**File:** `docs/solutions/database-issues/migration-regression-pattern.md`

**Problem:** When modifying existing RPC functions for a secondary purpose (security hardening, refactoring), previous bug fixes were silently lost. Example: Migration 007 fixed traditional character lookup (OR trad = search_char), but Migration 017 (for security) copy-pasted from older version, losing the fix. Gap between fix and regression: 7 weeks.

**Why It Matters for TMM:**
- Phase A creates **15 RPC functions** across T3-T8, T14
- These will be **modified in future phases** (optimizations, security hardening, feature additions)
- A regression in `deposit_to_cash` could silently allow overdrafts

### Application to Phase A Plan

**Add Migration Review Protocol:**

```markdown
### Pre-Modification RPC Checklist (Before Modifying Existing Functions)

**Every time you modify an existing RPC function:**

1. [ ] **List all migrations that have touched this function:**
   ```bash
   git log --oneline -- supabase/migrations/*.sql | grep -i function_name
   ```

2. [ ] **Read the entire evolution:**
   - Original migration (what it did)
   - All intermediate migrations (any changes? why?)
   - Then write the new one based on LATEST, not original

3. [ ] **Add comments explaining non-obvious clauses:**
   ```sql
   -- FIX (Migration 004): Use explicit alias k.id to avoid RETURNS TABLE ambiguity.
   -- Without this, WHERE k.id fails. See Issue #40.
   IF NOT EXISTS (
     SELECT 1 FROM kids k
     WHERE k.id = p_kid_id
   )
   ```

4. [ ] **Test primary functionality after secondary changes:**
   - If modifying for security, also test core behavior still works
   - Example: After adding `SET search_path`, verify the original query still returns correct results

5. [ ] **Code review must include function history:**
   - Reviewer: "Is this based on the latest version in the codebase?"
   - Reviewer: "Any fixes in intermediate migrations we might lose?"
```

**In Phase A Execution:** Since all RPCs are new, create this protocol for Post-Phase-A maintenance.

---

## 4. Simplified Context Words Filtering Issue (MEDIUM)

**File:** `docs/solutions/database-issues/simplified-context-words-drill-c-filtering.md`

**Problem:** `readings.context_words` contained simplified Chinese while `word_pairs.word` used traditional Chinese. String comparison failed silently. Root cause: data was inherited from dictionary at add time; later migrations fixed the source but not downstream copies.

**Why It Matters for TMM:**
- Schema has **data inheritance flows:**
  - `settings` (rates) → derived into transactions
  - `stock_prices` → derived into `stock_positions` (cost basis, gain/loss)
  - `hanzi_dojo_snapshots` → derived into transactions (delta)
- **Data flow validation critical:** When reading from source, must verify derived data matches

### Application to Phase A Plan

**Add to Data Model Validation:**

```markdown
### Data Inheritance Validation Pattern

**Pattern: Source-to-Derived Data Flows**

| Source Table | Derived Into | Validation |
|--------------|--------------|-----------|
| `settings` (mmf_apy) | `transactions` (interest computed) | Interest = mmf_balance * (apy/365) * days |
| `stock_prices` | `stock_positions` (current_value) | value = shares * latest_price |
| `transactions` (hanzi_dojo metadata) | next Hanzi Dojo deposit (delta) | delta = current points_total - previous points_total |

**Test Protocol:**

For each data flow, add a verification query:

```sql
-- Verify stock positions have valid ticker in stock_prices
SELECT sp.id, sp.ticker
FROM stock_positions sp
WHERE NOT EXISTS (
  SELECT 1 FROM stock_prices sprx
  WHERE sprx.ticker = sp.ticker
);
-- Should return 0 rows

-- Verify Hanzi Dojo deposits have consistent point tracking
-- Each Hanzi Dojo deposit should have points_total >= previous deposit's points_total
WITH ranked AS (
  SELECT t.kid_id, t.created_at,
    (t.metadata->>'points_total')::integer as points_total,
    LAG((t.metadata->>'points_total')::integer) OVER (
      PARTITION BY t.kid_id ORDER BY t.created_at
    ) as prev_total
  FROM transactions t
  WHERE t.metadata->>'source' = 'hanzi_dojo'
)
SELECT * FROM ranked r
WHERE r.prev_total IS NOT NULL AND r.points_total < r.prev_total;
-- Should return 0 rows
```

**Migration Checklist:**
- [ ] Does this modify source data (settings, stock_prices, hanzi_dojo transaction metadata)?
- [ ] If yes: Are there derived tables that should be updated? (list them)
- [ ] If yes: Is verification query included in migration?
```

---

## 5. Drill C QA Learnings (LOW)

**File:** `docs/solutions/process-learnings/drill-c-session-learnings-20260112.md`

**Problem:** Playwright MCP testing passed but missed state stability, visual consistency, and mobile rendering issues. 6 bugs found only by manual user testing.

**Why Minimal Impact for Phase A:**
- Phase A has **no drill features** (no interactive UI games)
- Phase A is **admin-only** (form submissions, data display, graphs)
- These concerns matter for **Phase B** (kid-facing UX)

### Applicability to Phase B (Future)

**For reference, if Phase B involves kid interactions:**

```markdown
### Manual QA Protocol (Phase B: Kid-Facing Features)

What Playwright MCP CAN test (Phase A admin):
- Element presence/absence
- Text content and accuracy
- Form submission and validation
- Data display correctness

What Playwright MCP CANNOT test (Phase B kid features):
- Visual stability (cards staying in place)
- Color/design token usage (ninja-green vs hardcoded #22c55e)
- Animation smoothness
- Mobile touch behavior (swipe, tap targets)
- Transient states (loading flashes)

If Phase B includes kid portfolio view or mini-investments:
- [ ] Manually test 3+ sequential actions, verify UI state stable
- [ ] Compare visual design against admin pages (consistency)
- [ ] Test on actual mobile device (not viewport resize)
- [ ] Use Agent Browser for visual/rendering validation
```

**Not applicable to Phase A—defer to Phase B planning.**

---

## 6. Solutions Directory README (REFERENCE)

**File:** `docs/solutions/README.md`

**Provides:** Template for documenting future bugs, gotchas, and prevention patterns.

### Application to Phase A Plan

**Create `/docs/solutions/` directory in TMM repo:**

```bash
docs/
└── solutions/
    ├── README.md  # Use template from Hanzi Dojo
    ├── database-issues/
    │   └── (created as TMM bugs are discovered)
    └── process-learnings/
        └── (created as development process issues emerge)
```

**Template for TMM bugs:**

```markdown
---
title: "Descriptive Title"
slug: kebab-case-slug
category: database-issues | process-learnings
tags: [relevant, tags]
severity: critical | high | medium | low
component: affected-component
date_solved: YYYY-MM-DD
related_issues: ["#XX"]
related_migrations: ["migration_name.sql"]
---

# Title

## Problem Symptom
What was observed by user/parent?

## Root Cause
Why did it happen?

## Solution
The fix applied.

## Prevention Strategies
How to avoid this in the future (checklists, patterns, etc.)
```

---

## Summary of Changes to Phase A Plan

### 1. Add SQL Development Checklist (T4-T8, T14)

**Location:** Before each RPC task description

**Content:** Explicit alias pattern with code example (see Section 1 above)

### 2. Add Migration Data Validation Pattern

**Location:** Insert between T2 (schema) and T3 (auth)

**Content:** Query-before-constraining pattern (see Section 2 above)

### 3. Add Pre-Modification RPC Checklist

**Location:** New section in PHASE_A_PLAN.md under "Development Standards"

**Content:** Migration history review protocol (see Section 3 above)

### 4. Add Data Inheritance Validation

**Location:** After T2 (schema), before RPCs begin

**Content:** Source-to-derived validation patterns for settings, stock_prices, hanzi_dojo_snapshots (see Section 4 above)

### 5. Create `/docs/solutions/` Directory

**Location:** `The Mini Mint/docs/solutions/`

**Content:** README.md template + placeholder for future bugs

### 6. Note for Phase B QA Planning

**Location:** `CLAUDE.md` or separate Phase B plan doc

**Content:** Playwright MCP vs. Agent Browser tooling guidance (see Section 5 above)

---

## Critical Implementation Order

These learnings must be integrated **before starting Phase A execution:**

1. **Create `/docs/solutions/` structure** (reference template ready)
2. **Add SQL checklist to each RPC task** (T4-T8, T14)
3. **Update PHASE_A_PLAN.md** with data validation requirements (T2)
4. **Add pre-modification protocol** to CLAUDE.md development standards

The learnings are **preventive**, not reactive — they should be in place before Phase A begins, not discovered during execution.

---

## Confidence Assessment

| Learning | Confidence It Applies | Risk If Ignored |
|----------|----------------------|-----------------|
| Explicit SQL aliases | 🟢 Very High | **CRITICAL** — ambiguous column errors in production |
| Query before constraining | 🟢 Very High | **HIGH** — migrations fail mid-rollout with incomplete fix |
| Review migration history | 🟢 High | **HIGH** — regression in atomic operations |
| Data inheritance validation | 🟢 High | **MEDIUM** — derived data inconsistency (silent bugs) |
| Drill QA lessons | 🔵 Low (Phase B future) | **N/A** for Phase A (no drill features yet) |

