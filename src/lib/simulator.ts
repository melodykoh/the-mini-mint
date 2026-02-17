import { supabase } from './supabase'

// ============================================================
// Types
// ============================================================

export interface SimulationResult {
  label: string
  finalAmount: number
  gain: number
  gainPct: number
  detail?: string
}

export interface StockReturn {
  ticker: string
  actual: { amount: number; pct: number } | null
  best: { amount: number; pct: number; startDate: string; endDate: string } | null
  worst: { amount: number; pct: number; startDate: string; endDate: string } | null
  insufficientHistory?: string
}

interface Settings {
  mmf_apy: number
  cd_3m_apy: number
  cd_6m_apy: number
  cd_12m_apy: number
}

// ============================================================
// Fixed-income projections (pure math)
// ============================================================

export function simulateGrowth(
  amount: number,
  months: number,
  rates: Settings,
): SimulationResult[] {
  const results: SimulationResult[] = []

  // Cash (mattress): no growth
  results.push({
    label: 'Cash (mattress)',
    finalAmount: round2(amount),
    gain: 0,
    gainPct: 0,
    detail: 'Your money just sits there',
  })

  // MMF: monthly compounding
  const mmfFinal = amount * Math.pow(1 + rates.mmf_apy / 12, months)
  results.push({
    label: 'Money Market Fund',
    finalAmount: round2(mmfFinal),
    gain: round2(mmfFinal - amount),
    gainPct: round2(((mmfFinal - amount) / amount) * 100),
    detail: `${(rates.mmf_apy * 100).toFixed(1)}% APY, compounded monthly`,
  })

  // CD projections with reinvestment compounding
  const cdTerms = [
    { months: 3, key: 'cd_3m_apy' as const, label: 'CD 3-month' },
    { months: 6, key: 'cd_6m_apy' as const, label: 'CD 6-month' },
    { months: 12, key: 'cd_12m_apy' as const, label: 'CD 12-month' },
  ]

  for (const cd of cdTerms) {
    // Only show CD terms that fit within the horizon
    if (cd.months > months) continue

    const apy = rates[cd.key]
    const terms = Math.floor(months / cd.months)
    // result = amount × (1 + apy × term_months/12)^terms
    const cdFinal = amount * Math.pow(1 + apy * (cd.months / 12), terms)

    results.push({
      label: cd.label,
      finalAmount: round2(cdFinal),
      gain: round2(cdFinal - amount),
      gainPct: round2(((cdFinal - amount) / amount) * 100),
      detail: `${(apy * 100).toFixed(1)}% APY, ${terms} term${terms !== 1 ? 's' : ''} reinvested`,
    })
  }

  return results
}

// ============================================================
// Stock projections (from historical price data)
// ============================================================

export async function getHistoricalStockReturns(
  ticker: string,
  months: number,
  amount: number,
): Promise<StockReturn> {
  // PostgREST caps at 1000 rows per request. 5 years of daily data is ~1260 rows.
  // Paginate using .range() to fetch all rows.
  const PAGE_SIZE = 1000
  let prices: { date: string; close_price: number }[] = []
  let offset = 0

  while (true) {
    const { data, error: pageError } = await supabase
      .from('stock_prices')
      .select('date, close_price')
      .eq('ticker', ticker)
      .order('date', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)

    if (pageError) throw pageError
    if (!data || data.length === 0) break
    prices = prices.concat(data)
    if (data.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  if (!prices || prices.length < 2) {
    return {
      ticker,
      actual: null,
      best: null,
      worst: null,
      insufficientHistory: `No price history available for ${ticker}`,
    }
  }

  // Check data sufficiency by actual date range, not row count.
  // Row count × 21 days/month is an approximation that can be off by 20+ days.
  // Use a 30-day tolerance (same as the rolling window lookups) so data that's
  // a few days short of exactly N months still qualifies.
  const latestDate = prices[prices.length - 1].date
  const earliestDate = prices[0].date
  const neededStartDate = subtractMonths(latestDate, months)
  const earliestMs = new Date(earliestDate).getTime()
  const neededMs = new Date(neededStartDate).getTime()
  const shortfallDays = (earliestMs - neededMs) / (24 * 60 * 60 * 1000)

  if (shortfallDays > 30) {
    const approxMonths = Math.floor(monthsBetween(earliestDate, latestDate))
    return {
      ticker,
      actual: null,
      best: null,
      worst: null,
      insufficientHistory: `${ticker} has ~${approxMonths} months of data, need ${months}`,
    }
  }

  const latestPrice = Number(prices[prices.length - 1].close_price)

  // Find actual return: price N months ago vs latest
  const targetDate = subtractMonths(latestDate, months)
  const pastIdx = findClosestDateIndex(prices, targetDate)
  const pastPrice = Number(prices[pastIdx].close_price)

  const actualReturn = (latestPrice / pastPrice) * amount
  const actual = {
    amount: round2(actualReturn),
    pct: round2(((latestPrice / pastPrice) - 1) * 100),
  }

  // Scan all rolling windows of N months (date-based, not row-offset-based).
  // For each starting row, find the end row that is N months later.
  let bestReturn = -Infinity
  let worstReturn = Infinity
  let bestStart = 0, bestEnd = 0
  let worstStart = 0, worstEnd = 0

  for (let i = 0; i < prices.length; i++) {
    const windowEnd = addMonths(prices[i].date, months)
    const endIdx = findClosestDateIndex(prices, windowEnd)
    // Skip if the end date isn't close enough (within 30 days of target)
    const endDateDiff = Math.abs(
      new Date(prices[endIdx].date).getTime() - new Date(windowEnd).getTime(),
    )
    if (endDateDiff > 30 * 24 * 60 * 60 * 1000) continue
    if (endIdx <= i) continue

    const startP = Number(prices[i].close_price)
    const endP = Number(prices[endIdx].close_price)
    const ret = endP / startP

    if (ret > bestReturn) {
      bestReturn = ret
      bestStart = i
      bestEnd = endIdx
    }
    if (ret < worstReturn) {
      worstReturn = ret
      worstStart = i
      worstEnd = endIdx
    }
  }

  const best = bestReturn > -Infinity
    ? {
        amount: round2(bestReturn * amount),
        pct: round2((bestReturn - 1) * 100),
        startDate: prices[bestStart].date,
        endDate: prices[bestEnd].date,
      }
    : null

  const worst = worstReturn < Infinity
    ? {
        amount: round2(worstReturn * amount),
        pct: round2((worstReturn - 1) * 100),
        startDate: prices[worstStart].date,
        endDate: prices[worstEnd].date,
      }
    : null

  return { ticker, actual, best, worst }
}

// ============================================================
// Fetch current settings for simulator
// ============================================================

export async function getSimulatorSettings(): Promise<Settings> {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', ['mmf_apy', 'cd_3m_apy', 'cd_6m_apy', 'cd_12m_apy'])

  if (error) throw error

  const settings: Record<string, number> = {}
  for (const row of data ?? []) {
    settings[row.key] = parseFloat(row.value)
  }

  return {
    mmf_apy: settings.mmf_apy ?? 0,
    cd_3m_apy: settings.cd_3m_apy ?? 0,
    cd_6m_apy: settings.cd_6m_apy ?? 0,
    cd_12m_apy: settings.cd_12m_apy ?? 0,
  }
}

// ============================================================
// Helpers
// ============================================================

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function subtractMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr)
  d.setMonth(d.getMonth() - months)
  return d.toISOString().split('T')[0]
}

function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr)
  d.setMonth(d.getMonth() + months)
  return d.toISOString().split('T')[0]
}

function monthsBetween(startDate: string, endDate: string): number {
  const s = new Date(startDate)
  const e = new Date(endDate)
  // Whole months + fractional month from days. Use 30.44 (avg days/month) for precision.
  const wholeMonths = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth())
  const dayFraction = (e.getDate() - s.getDate()) / 30.44
  // Floor to avoid rejecting data that's days short of a whole month boundary.
  // The rolling window already uses a 30-day tolerance for individual lookups.
  return Math.floor(wholeMonths + dayFraction)
}

function findClosestDateIndex(
  prices: { date: string; close_price: number }[],
  targetDate: string,
): number {
  // Binary search for closest date
  let lo = 0
  let hi = prices.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (prices[mid].date < targetDate) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  // lo is the first date >= targetDate, check if lo-1 is closer
  if (lo > 0) {
    const diffLo = Math.abs(
      new Date(prices[lo].date).getTime() - new Date(targetDate).getTime(),
    )
    const diffPrev = Math.abs(
      new Date(prices[lo - 1].date).getTime() - new Date(targetDate).getTime(),
    )
    if (diffPrev < diffLo) return lo - 1
  }
  return lo
}
