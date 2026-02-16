import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  simulateGrowth,
  getHistoricalStockReturns,
  getSimulatorSettings,
  type SimulationResult,
  type StockReturn,
} from '../lib/simulator'
import { getTrackedTickers } from '../lib/stock-prices'

const HORIZONS = [
  { label: '3 mo', months: 3 },
  { label: '6 mo', months: 6 },
  { label: '1 yr', months: 12 },
  { label: '3 yr', months: 36 },
  { label: '5 yr', months: 60 },
]

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(n)
}

function formatPct(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

function gainColor(n: number): string {
  if (n > 0) return 'text-emerald-600'
  if (n < 0) return 'text-red-600'
  return 'text-gray-500'
}

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
        <div className="mt-2 flex gap-2">
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

      {/* Stock results */}
      {tickers && tickers.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold">Stocks</h2>
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
