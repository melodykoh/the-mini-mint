import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  simulateGrowth,
  getHistoricalStockReturns,
  getSimulatorSettings,
  type SimulationResult,
  type StockReturn,
} from '../lib/simulator'
import { getTrackedTickers, backfillStockHistory } from '../lib/stock-prices'
import { supabase } from '../lib/supabase'
import { formatMoney } from '../lib/format'
import { extractErrorMessage } from '../lib/errors'

const HORIZONS = [
  { label: '3 mo', months: 3 },
  { label: '6 mo', months: 6 },
  { label: '1 yr', months: 12 },
  { label: '3 yr', months: 36 },
  { label: '5 yr', months: 60 },
]

function formatPct(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

function gainColor(n: number): string {
  if (n > 0) return 'text-emerald-600'
  if (n < 0) return 'text-red-600'
  return 'text-gray-500'
}

// ============================================================
// Performance Summary — YTD, 1yr, 5yr returns from price data
// ============================================================

interface PerfPeriod {
  label: string
  pct: number | null
}

async function getPerformanceSummary(ticker: string): Promise<PerfPeriod[]> {
  const { data: prices, error } = await supabase
    .from('stock_prices')
    .select('date, close_price')
    .eq('ticker', ticker)
    .order('date', { ascending: true })

  if (error || !prices || prices.length < 2) return []

  const latest = prices[prices.length - 1]
  const latestPrice = Number(latest.close_price)
  const latestDate = new Date(latest.date)

  const findClosest = (target: Date): number | null => {
    const targetStr = target.toISOString().split('T')[0]
    // Binary search for closest date
    let lo = 0
    let hi = prices.length - 1
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (prices[mid].date < targetStr) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) {
      const diffLo = Math.abs(new Date(prices[lo].date).getTime() - target.getTime())
      const diffPrev = Math.abs(new Date(prices[lo - 1].date).getTime() - target.getTime())
      if (diffPrev < diffLo) lo = lo - 1
    }
    // If the closest date is more than 30 days off, data is insufficient
    const diff = Math.abs(new Date(prices[lo].date).getTime() - target.getTime())
    if (diff > 30 * 24 * 60 * 60 * 1000) return null
    return lo
  }

  const calcReturn = (targetDate: Date): number | null => {
    const idx = findClosest(targetDate)
    if (idx === null) return null
    const pastPrice = Number(prices[idx].close_price)
    if (pastPrice === 0) return null
    return ((latestPrice / pastPrice) - 1) * 100
  }

  // YTD: Jan 1 of current year
  const ytdDate = new Date(latestDate.getFullYear(), 0, 1)
  // 12 months ago
  const oneYrDate = new Date(latestDate)
  oneYrDate.setMonth(oneYrDate.getMonth() - 12)
  // 5 years ago
  const fiveYrDate = new Date(latestDate)
  fiveYrDate.setFullYear(fiveYrDate.getFullYear() - 5)

  return [
    { label: 'YTD', pct: calcReturn(ytdDate) },
    { label: 'Last 12mo', pct: calcReturn(oneYrDate) },
    { label: 'Last 5yr', pct: calcReturn(fiveYrDate) },
  ]
}

// ============================================================
// Stock Explorer Component
// ============================================================

function StockExplorer({
  months,
  parsedAmount,
}: {
  months: number
  parsedAmount: number
}) {
  const [tickerInput, setTickerInput] = useState('')
  const [activeTicker, setActiveTicker] = useState<string | null>(null)
  const [explorerError, setExplorerError] = useState<string | null>(null)

  // Mutation for backfilling price data
  const backfillMutation = useMutation({
    mutationFn: async (ticker: string) => {
      // Check if sufficient data already exists (need ~100+ rows for meaningful analysis).
      // A few rows from daily refresh don't count — we need the 5-year backfill.
      const { count, error: countError } = await supabase
        .from('stock_prices')
        .select('*', { count: 'exact', head: true })
        .eq('ticker', ticker)

      if (countError) throw countError

      const MIN_ROWS_FOR_ANALYSIS = 100
      if (count && count >= MIN_ROWS_FOR_ANALYSIS) {
        return { alreadyExists: true }
      }

      // Backfill (runs even if a few rows exist from daily refresh)
      const result = await backfillStockHistory([ticker])
      if (result.failed?.length > 0) {
        throw new Error(result.failed[0].error)
      }
      // "skipped" means the API returned no values — treat as invalid ticker
      if (result.rows_upserted === 0) {
        throw new Error('no_data')
      }
      return { alreadyExists: false, result }
    },
    onSuccess: (_data, ticker) => {
      setActiveTicker(ticker)
      setExplorerError(null)
    },
    onError: (err: unknown) => {
      setActiveTicker(null)
      const msg = extractErrorMessage(err)
      if (msg === 'no_data' || msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no data')) {
        setExplorerError(`Couldn't find price data for ${tickerInput.toUpperCase()}. Check the ticker symbol.`)
      } else if (msg.toLowerCase().includes('rate') || msg.toLowerCase().includes('limit') || msg.toLowerCase().includes('429')) {
        setExplorerError('Price data service is busy. Wait a moment and try again.')
      } else {
        setExplorerError(`Couldn't find price data for ${tickerInput.toUpperCase()}. Check the ticker symbol.`)
      }
    },
  })

  const handleLookUp = () => {
    const ticker = tickerInput.trim().toUpperCase()
    if (!ticker) return
    setExplorerError(null)
    backfillMutation.mutate(ticker)
  }

  // Performance summary (not tied to horizon/amount)
  const { data: perfSummary } = useQuery({
    queryKey: ['perf-summary', activeTicker],
    queryFn: () => getPerformanceSummary(activeTicker!),
    enabled: !!activeTicker,
  })

  // Simulation results (tied to horizon/amount)
  const { data: explorerReturns, isLoading: explorerLoading } = useQuery({
    queryKey: ['explorer-returns', activeTicker, months, parsedAmount],
    queryFn: () => getHistoricalStockReturns(activeTicker!, months, parsedAmount),
    enabled: !!activeTicker && parsedAmount > 0,
  })

  // Kids for "Buy for" links
  const { data: kids } = useQuery({
    queryKey: ['kids'],
    queryFn: async () => {
      const { data } = await supabase.from('kids').select('id, name').order('name')
      return data ?? []
    },
    enabled: !!activeTicker,
  })

  const nonQaKids = (kids ?? []).filter((k) => !k.name.startsWith('QA-'))

  return (
    <div className="mt-8">
      <h2 className="text-lg font-semibold">Explore a Stock</h2>

      {/* Ticker input */}
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={tickerInput}
          onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') handleLookUp() }}
          placeholder="Ticker (e.g., NVDA)"
          maxLength={10}
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm uppercase shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        />
        <button
          onClick={handleLookUp}
          disabled={!tickerInput.trim() || backfillMutation.isPending}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Look Up
        </button>
      </div>

      {/* Loading state */}
      {backfillMutation.isPending && (
        <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          Fetching price history for {tickerInput.toUpperCase()}...
        </div>
      )}

      {/* Error state */}
      {explorerError && (
        <p className="mt-3 text-sm text-red-600">{explorerError}</p>
      )}

      {/* Results */}
      {activeTicker && !backfillMutation.isPending && (
        <div className="mt-4 space-y-4">
          {/* Performance summary */}
          {perfSummary && perfSummary.length > 0 && (
            <div className="rounded-lg border border-gray-200 px-4 py-3">
              <p className="text-sm font-semibold">{activeTicker} — Historical Returns</p>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                {perfSummary.map((p) => (
                  <div key={p.label}>
                    <p className="text-xs text-gray-500">{p.label}</p>
                    {p.pct !== null ? (
                      <p className={`text-sm font-medium ${gainColor(p.pct)}`}>
                        {formatPct(p.pct)}
                      </p>
                    ) : (
                      <p className="text-sm text-gray-400">N/A</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Simulation results */}
          {parsedAmount > 0 && (
            <>
              {explorerLoading ? (
                <p className="text-sm text-gray-400">Calculating projections...</p>
              ) : explorerReturns ? (
                <div className="rounded-lg border border-gray-200 px-4 py-3">
                  <p className="text-sm font-semibold">
                    {activeTicker} — What would {formatMoney(parsedAmount)} become?
                  </p>

                  {explorerReturns.insufficientHistory ? (
                    <p className="mt-2 text-xs text-gray-500">
                      {explorerReturns.insufficientHistory}
                    </p>
                  ) : (
                    <>
                      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                        {explorerReturns.worst && (
                          <div>
                            <p className="text-xs text-gray-500">Worst case</p>
                            <p className="text-sm font-medium text-red-600">
                              {formatMoney(explorerReturns.worst.amount)}
                            </p>
                            <p className="text-xs text-red-500">
                              {formatPct(explorerReturns.worst.pct)}
                            </p>
                          </div>
                        )}
                        {explorerReturns.actual && (
                          <div>
                            <p className="text-xs text-gray-500">Actual (past)</p>
                            <p className={`text-sm font-medium ${gainColor(explorerReturns.actual.pct)}`}>
                              {formatMoney(explorerReturns.actual.amount)}
                            </p>
                            <p className={`text-xs ${gainColor(explorerReturns.actual.pct)}`}>
                              {formatPct(explorerReturns.actual.pct)}
                            </p>
                          </div>
                        )}
                        {explorerReturns.best && (
                          <div>
                            <p className="text-xs text-gray-500">Best case</p>
                            <p className="text-sm font-medium text-emerald-600">
                              {formatMoney(explorerReturns.best.amount)}
                            </p>
                            <p className="text-xs text-emerald-500">
                              {formatPct(explorerReturns.best.pct)}
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Kid-friendly summary */}
                      {explorerReturns.worst && explorerReturns.best && (
                        <p className="mt-3 text-xs text-gray-600 leading-relaxed">
                          In the worst {months >= 12 ? `${months / 12}-year` : `${months}-month`} stretch,
                          your {formatMoney(parsedAmount)} would have become {formatMoney(explorerReturns.worst.amount)}.
                          In the best {months >= 12 ? `${months / 12}-year` : `${months}-month`} stretch,
                          it could have become {formatMoney(explorerReturns.best.amount)}.
                        </p>
                      )}
                    </>
                  )}
                </div>
              ) : null}
            </>
          )}

          {/* Buy for kid links */}
          {nonQaKids.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {nonQaKids.map((kid) => (
                <Link
                  key={kid.id}
                  to={`/kid/${kid.id}/invest`}
                  className="inline-flex items-center rounded-md bg-purple-50 px-3 py-2 text-sm font-medium text-purple-700 hover:bg-purple-100"
                >
                  Buy {activeTicker} for {kid.name}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================
// Main Simulator Page
// ============================================================

export default function Simulator() {
  const [amount, setAmount] = useState('100')
  const [months, setMonths] = useState(12)

  const parsedAmount = parseFloat(amount) || 0

  const { data: settings } = useQuery({
    queryKey: ['simulator-settings'],
    queryFn: getSimulatorSettings,
  })

  const { data: tickers } = useQuery({
    queryKey: ['tracked-tickers'],
    queryFn: getTrackedTickers,
  })

  // Compute fixed-income projections (sync, pure math)
  const fixedIncome: SimulationResult[] =
    settings && parsedAmount > 0
      ? simulateGrowth(parsedAmount, months, settings)
      : []

  // Fetch stock returns for each tracked ticker
  const { data: stockReturns, isLoading: stocksLoading } = useQuery({
    queryKey: ['stock-returns', tickers, months, parsedAmount],
    queryFn: async () => {
      if (!tickers || tickers.length === 0 || parsedAmount <= 0) return []
      const results: StockReturn[] = []
      for (const ticker of tickers) {
        const result = await getHistoricalStockReturns(ticker, months, parsedAmount)
        results.push(result)
      }
      return results
    },
    enabled: !!tickers && tickers.length > 0 && parsedAmount > 0,
  })

  return (
    <div className="mx-auto max-w-2xl p-4">
      <h1 className="text-2xl font-bold">Investment Simulator</h1>
      <p className="mt-1 text-sm text-gray-500">
        What would your money become?
      </p>

      {/* Amount input */}
      <div className="mt-6">
        <label className="block text-sm font-medium text-gray-700">
          Starting amount
        </label>
        <div className="relative mt-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
            $
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="block w-full rounded-md border border-gray-300 py-2 pl-7 pr-3 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            placeholder="100.00"
          />
        </div>
      </div>

      {/* Time horizon pills */}
      <div className="mt-4">
        <label className="block text-sm font-medium text-gray-700">
          Time horizon
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          {HORIZONS.map((h) => (
            <button
              key={h.months}
              onClick={() => setMonths(h.months)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                months === h.months
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {h.label}
            </button>
          ))}
        </div>
      </div>

      {/* Fixed-income results */}
      {fixedIncome.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold">Fixed Income</h2>
          <div className="mt-3 space-y-2">
            {fixedIncome.map((r) => (
              <div
                key={r.label}
                className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium">{r.label}</p>
                  <p className="text-xs text-gray-500">{r.detail}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold">
                    {formatMoney(r.finalAmount)}
                  </p>
                  <p className={`text-xs ${gainColor(r.gain)}`}>
                    {r.gain !== 0
                      ? `${formatMoney(r.gain)} (${formatPct(r.gainPct)})`
                      : 'no growth'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stock explorer */}
      <StockExplorer months={months} parsedAmount={parsedAmount} />

      {/* Owned stock results */}
      {tickers && tickers.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold">Your Stocks</h2>
          <p className="text-xs text-gray-500">
            Based on past performance — not guaranteed
          </p>

          {stocksLoading ? (
            <p className="mt-3 text-sm text-gray-400">Loading stock data...</p>
          ) : (
            <div className="mt-3 space-y-3">
              {(stockReturns ?? []).map((sr) => (
                <div
                  key={sr.ticker}
                  className="rounded-lg border border-gray-200 px-4 py-3"
                >
                  <p className="text-sm font-semibold">{sr.ticker}</p>

                  {sr.insufficientHistory ? (
                    <p className="mt-1 text-xs text-gray-500">
                      {sr.insufficientHistory}
                    </p>
                  ) : (
                    <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                      {sr.worst && (
                        <div>
                          <p className="text-xs text-gray-500">Worst case</p>
                          <p className="text-sm font-medium text-red-600">
                            {formatMoney(sr.worst.amount)}
                          </p>
                          <p className="text-xs text-red-500">
                            {formatPct(sr.worst.pct)}
                          </p>
                        </div>
                      )}
                      {sr.actual && (
                        <div>
                          <p className="text-xs text-gray-500">
                            Actual (past)
                          </p>
                          <p
                            className={`text-sm font-medium ${gainColor(sr.actual.pct)}`}
                          >
                            {formatMoney(sr.actual.amount)}
                          </p>
                          <p
                            className={`text-xs ${gainColor(sr.actual.pct)}`}
                          >
                            {formatPct(sr.actual.pct)}
                          </p>
                        </div>
                      )}
                      {sr.best && (
                        <div>
                          <p className="text-xs text-gray-500">Best case</p>
                          <p className="text-sm font-medium text-emerald-600">
                            {formatMoney(sr.best.amount)}
                          </p>
                          <p className="text-xs text-emerald-500">
                            {formatPct(sr.best.pct)}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {parsedAmount <= 0 && (
        <p className="mt-8 text-center text-sm text-gray-400">
          Enter an amount to see projections
        </p>
      )}
    </div>
  )
}
