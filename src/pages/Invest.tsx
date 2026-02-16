import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MoneyInput } from '../components/MoneyInput'
import {
  getCashBalance,
  getMmfBalance,
  investInMmf,
  redeemFromMmf,
  getCdLots,
  createCd,
  matureCd,
  breakCd,
  getStockPositions,
  buyStock,
  sellStock,
} from '../lib/transactions'
import { supabase } from '../lib/supabase'

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(n)
}

function gainColor(n: number): string {
  if (n > 0) return 'text-emerald-600'
  if (n < 0) return 'text-red-600'
  return 'text-gray-500'
}

// ============================================================
// MMF Section (T13a)
// ============================================================

function MmfSection({ kidId }: { kidId: string }) {
  const queryClient = useQueryClient()
  const [investAmount, setInvestAmount] = useState('')
  const [redeemAmount, setRedeemAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const { data: mmfBalance = 0 } = useQuery({
    queryKey: ['mmf-balance', kidId],
    queryFn: () => getMmfBalance(kidId),
  })

  const { data: mmfApy } = useQuery({
    queryKey: ['mmf-apy'],
    queryFn: async () => {
      const { data } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'mmf_apy')
        .single()
      return data ? parseFloat(data.value) : 0
    },
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['portfolio'] })
    queryClient.invalidateQueries({ queryKey: ['cash-balance'] })
    queryClient.invalidateQueries({ queryKey: ['mmf-balance'] })
  }

  const handleInvest = async () => {
    const amt = parseFloat(investAmount)
    if (!amt || amt <= 0) return
    setError(null)
    setSubmitting(true)
    try {
      await investInMmf(kidId, amt)
      setInvestAmount('')
      invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRedeem = async () => {
    const amt = parseFloat(redeemAmount)
    if (!amt || amt <= 0) return
    setError(null)
    setSubmitting(true)
    try {
      await redeemFromMmf(kidId, amt)
      setRedeemAmount('')
      invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h3 className="text-base font-semibold">Money Market Fund</h3>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="text-xl font-bold">{formatMoney(mmfBalance)}</span>
        {mmfApy !== undefined && (
          <span className="text-sm text-gray-500">
            {(mmfApy * 100).toFixed(1)}% APY
          </span>
        )}
      </div>

      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <MoneyInput
            id="mmf-invest"
            label="Add to MMF"
            value={investAmount}
            onChange={setInvestAmount}
          />
          <button
            onClick={handleInvest}
            disabled={submitting}
            className="mt-2 w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Invest
          </button>
        </div>
        <div>
          <MoneyInput
            id="mmf-redeem"
            label="Withdraw from MMF"
            value={redeemAmount}
            onChange={setRedeemAmount}
          />
          <button
            onClick={handleRedeem}
            disabled={submitting}
            className="mt-2 w-full rounded-md bg-gray-600 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            Withdraw
          </button>
        </div>
      </div>
    </section>
  )
}

// ============================================================
// CD Section (T13b)
// ============================================================

function CdSection({ kidId }: { kidId: string }) {
  const queryClient = useQueryClient()
  const [cdAmount, setCdAmount] = useState('')
  const [cdTerm, setCdTerm] = useState(3)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const { data: lots = [] } = useQuery({
    queryKey: ['cd-lots', kidId],
    queryFn: () => getCdLots(kidId),
  })

  const activeLots = lots.filter((l) => l.status === 'active')

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['portfolio'] })
    queryClient.invalidateQueries({ queryKey: ['cash-balance'] })
    queryClient.invalidateQueries({ queryKey: ['cd-lots'] })
  }

  const handleCreate = async () => {
    const amt = parseFloat(cdAmount)
    if (!amt || amt <= 0) return
    setError(null)
    setSubmitting(true)
    try {
      await createCd(kidId, amt, cdTerm)
      setCdAmount('')
      invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleMature = async (lotId: string) => {
    setError(null)
    setSubmitting(true)
    try {
      await matureCd(lotId)
      invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleBreak = async (lotId: string) => {
    setError(null)
    setSubmitting(true)
    try {
      await breakCd(lotId)
      invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  const isMatured = (lot: { maturity_date: string }) =>
    new Date(lot.maturity_date) <= new Date()

  const daysRemaining = (lot: { maturity_date: string }) => {
    const diff = new Date(lot.maturity_date).getTime() - Date.now()
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h3 className="text-base font-semibold">Certificates of Deposit</h3>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {activeLots.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">
          No CDs yet — lock up money for a higher return!
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {activeLots.map((lot) => (
            <div
              key={lot.id}
              className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium">
                  {formatMoney(Number(lot.principal))} · {lot.term_months}mo ·{' '}
                  {(Number(lot.apy) * 100).toFixed(1)}%
                </p>
                <p className="text-xs text-gray-500">
                  {isMatured(lot)
                    ? 'Matured!'
                    : `${daysRemaining(lot)} days left · matures ${lot.maturity_date}`}
                </p>
              </div>
              <div>
                {isMatured(lot) ? (
                  <button
                    onClick={() => handleMature(lot.id)}
                    disabled={submitting}
                    className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Collect
                  </button>
                ) : (
                  <button
                    onClick={() => handleBreak(lot.id)}
                    disabled={submitting}
                    className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    Break Early
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4">
        <p className="text-sm font-medium text-gray-700">Open New CD</p>
        <div className="mt-2 flex gap-2">
          {[3, 6, 12].map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => setCdTerm(term)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium ${
                cdTerm === term
                  ? 'bg-amber-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {term}mo
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <div className="flex-1">
            <MoneyInput
              id="cd-amount"
              label="Amount"
              value={cdAmount}
              onChange={setCdAmount}
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={submitting}
            className="mt-6 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            Lock it up
          </button>
        </div>
      </div>
    </section>
  )
}

// ============================================================
// Stock Section (T13c)
// ============================================================

function StockSection({ kidId }: { kidId: string }) {
  const queryClient = useQueryClient()
  const [buyTicker, setBuyTicker] = useState('')
  const [buyAmount, setBuyAmount] = useState('')
  const [sellAmounts, setSellAmounts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const { data: positions = [] } = useQuery({
    queryKey: ['stock-positions', kidId],
    queryFn: () => getStockPositions(kidId),
  })

  const { data: positionLimit } = useQuery({
    queryKey: ['position-limit'],
    queryFn: async () => {
      const { data } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'stock_position_limit')
        .single()
      return data ? parseInt(data.value) : 5
    },
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['portfolio'] })
    queryClient.invalidateQueries({ queryKey: ['cash-balance'] })
    queryClient.invalidateQueries({ queryKey: ['stock-positions'] })
  }

  const handleBuy = async () => {
    const amt = parseFloat(buyAmount)
    if (!buyTicker || !amt || amt <= 0) return
    setError(null)
    setSubmitting(true)
    try {
      await buyStock(kidId, buyTicker.toUpperCase(), amt)
      setBuyTicker('')
      setBuyAmount('')
      invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleSell = async (ticker: string, sellAll: boolean) => {
    const amt = sellAll ? 0 : parseFloat(sellAmounts[ticker] ?? '0')
    if (!sellAll && (!amt || amt <= 0)) return
    setError(null)
    setSubmitting(true)
    try {
      await sellStock(kidId, ticker, amt)
      setSellAmounts((prev) => ({ ...prev, [ticker]: '' }))
      invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  const isStale = (pos: { current_price: number }) => {
    // We don't have the date in the enriched position, but if price is 0 it's stale
    return pos.current_price === 0
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">Stocks & ETFs</h3>
        <span className="text-xs text-gray-500">
          {positions.length} of {positionLimit ?? 5} positions
        </span>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {positions.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">
          Pick your first company to invest in!
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {positions.map((pos) => (
            <div
              key={pos.ticker}
              className="rounded-lg border border-gray-100 px-3 py-2"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">
                    {pos.ticker}
                    {isStale(pos) && (
                      <span className="ml-2 text-xs text-amber-600">
                        Stale price
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">
                    {Number(pos.shares).toFixed(4)} shares · cost{' '}
                    {formatMoney(Number(pos.cost_basis))}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium">
                    {formatMoney(pos.current_value)}
                  </p>
                  <p className={`text-xs ${gainColor(pos.gain_loss)}`}>
                    {pos.gain_loss >= 0 ? '+' : ''}
                    {formatMoney(pos.gain_loss)} ({pos.gain_loss_pct >= 0 ? '+' : ''}
                    {pos.gain_loss_pct.toFixed(1)}%)
                  </p>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="$ amount"
                  value={sellAmounts[pos.ticker] ?? ''}
                  onChange={(e) =>
                    setSellAmounts((prev) => ({
                      ...prev,
                      [pos.ticker]: e.target.value,
                    }))
                  }
                  className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm"
                />
                <button
                  onClick={() => handleSell(pos.ticker, false)}
                  disabled={submitting}
                  className="rounded-md bg-gray-600 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                >
                  Sell
                </button>
                <button
                  onClick={() => handleSell(pos.ticker, true)}
                  disabled={submitting}
                  className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Sell All
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4">
        <p className="text-sm font-medium text-gray-700">Buy Stock/ETF</p>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={buyTicker}
            onChange={(e) => setBuyTicker(e.target.value.toUpperCase())}
            placeholder="Ticker (e.g., NVDA)"
            maxLength={10}
            className="w-28 rounded-md border border-gray-300 px-3 py-2 text-sm uppercase"
          />
          <div className="flex-1">
            <MoneyInput
              id="stock-buy"
              label=""
              value={buyAmount}
              onChange={setBuyAmount}
              placeholder="Amount"
            />
          </div>
          <button
            onClick={handleBuy}
            disabled={submitting}
            className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            Buy
          </button>
        </div>
      </div>
    </section>
  )
}

// ============================================================
// Invest Page (combines T13a, T13b, T13c)
// ============================================================

export default function Invest() {
  const { kidId } = useParams<{ kidId: string }>()

  const { data: kids } = useQuery({
    queryKey: ['kids'],
    queryFn: async () => {
      const { data } = await supabase.from('kids').select('*').order('name')
      return data ?? []
    },
  })

  const { data: cash = 0 } = useQuery({
    queryKey: ['cash-balance', kidId],
    queryFn: () => getCashBalance(kidId!),
    enabled: !!kidId,
  })

  const kidName = kids?.find((k) => k.id === kidId)?.name ?? 'Unknown'

  if (!kidId) return <p>No kid selected</p>

  return (
    <div className="mx-auto max-w-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{kidName}'s Investments</h1>
          <p className="mt-1 text-sm text-gray-500">
            Available to invest:{' '}
            <span className="font-semibold text-blue-600">
              {formatMoney(cash)}
            </span>
          </p>
        </div>
        <Link
          to="/"
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          Back
        </Link>
      </div>

      <div className="mt-6 space-y-4">
        <MmfSection kidId={kidId} />
        <CdSection kidId={kidId} />
        <StockSection kidId={kidId} />
      </div>
    </div>
  )
}
