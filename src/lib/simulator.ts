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
  // Fetch all historical prices for this ticker, sorted ascending
  // PostgREST defaults to 1000 rows — 5 years of daily data is ~1260 rows.
  // Explicit limit ensures we get the full history.
  const { data: prices, error } = await supabase
    .from('stock_prices')
    .select('date, close_price')
    .eq('ticker', ticker)
    .order('date', { ascending: true })
    .limit(5000)

  if (error) throw error
  if (!prices || prices.length < 2) {
    return {
      ticker,
      actual: null,
      best: null,
      worst: null,
      insufficientHistory: `No price history available for ${ticker}`,
    }
  }

  const tradingDaysNeeded = Math.round(months * 21) // ~21 trading days/month
  if (prices.length < tradingDaysNeeded) {
    const availableMonths = Math.floor(prices.length / 21)
    return {
      ticker,
      actual: null,
      best: null,
      worst: null,
      insufficientHistory: `${ticker} has ~${availableMonths} months of data, need ${months}`,
    }
  }

  const latestPrice = Number(prices[prices.length - 1].close_price)
  const latestDate = prices[prices.length - 1].date

  // Find actual return: price N months ago vs latest
  const targetDate = subtractMonths(latestDate, months)
  const pastIdx = findClosestDateIndex(prices, targetDate)
  const pastPrice = Number(prices[pastIdx].close_price)

  const actualReturn = (latestPrice / pastPrice) * amount
  const actual = {
    amount: round2(actualReturn),
    pct: round2(((latestPrice / pastPrice) - 1) * 100),
  }

  // Scan all rolling windows of N months
  let bestReturn = -Infinity
  let worstReturn = Infinity
  let bestStart = 0, bestEnd = 0
  let worstStart = 0, worstEnd = 0

  for (let i = 0; i < prices.length - tradingDaysNeeded; i++) {
    const endIdx = i + tradingDaysNeeded
    if (endIdx >= prices.length) break

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
