import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KidSelector } from '../components/KidSelector'
import { MoneyInput } from '../components/MoneyInput'
import {
  withdrawFromCash,
  getCashBalance,
  getMmfBalance,
  getStockPositions,
} from '../lib/transactions'
import { supabase } from '../lib/supabase'

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(n)
}

type SourceBucket = 'cash' | 'mmf' | 'stock'

export default function Spend() {
  const queryClient = useQueryClient()
  const [kidId, setKidId] = useState('')
  const [source, setSource] = useState<SourceBucket>('cash')
  const [ticker, setTicker] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: cash = 0 } = useQuery({
    queryKey: ['cash-balance', kidId],
    queryFn: () => getCashBalance(kidId),
    enabled: !!kidId,
  })

  const { data: mmf = 0 } = useQuery({
    queryKey: ['mmf-balance', kidId],
    queryFn: () => getMmfBalance(kidId),
    enabled: !!kidId,
  })

  const { data: positions = [] } = useQuery({
    queryKey: ['stock-positions', kidId],
    queryFn: () => getStockPositions(kidId),
    enabled: !!kidId,
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const amt = parseFloat(amount)
    if (!amt || amt <= 0 || !kidId || !note.trim()) return
    setError(null)
    setSuccess(null)
    setSubmitting(true)

    try {
      if (source === 'cash') {
        await withdrawFromCash(kidId, amt, note)
        setSuccess(`Spent ${formatMoney(amt)} from cash`)
      } else if (source === 'mmf') {
        const { error } = await supabase.rpc('spend_from_mmf', {
          p_kid_id: kidId,
          p_amount: amt,
          p_note: note,
        })
        if (error) throw error
        setSuccess(`Spent ${formatMoney(amt)} from MMF`)
      } else if (source === 'stock') {
        if (!ticker) {
          setError('Select a stock to sell from')
          setSubmitting(false)
          return
        }
        const { data, error } = await supabase.rpc('spend_from_stock', {
          p_kid_id: kidId,
          p_ticker: ticker,
          p_amount: amt,
          p_note: note,
        })
        if (error) throw error
        const result = data as { shares_sold: number; realized_gain_loss: number }[] | null
        const gain = result?.[0]?.realized_gain_loss ?? 0
        setSuccess(
          `Spent ${formatMoney(amt)} from ${ticker}${gain !== 0 ? ` (${gain >= 0 ? 'gained' : 'lost'} ${formatMoney(Math.abs(gain))})` : ''}`,
        )
      }

      setAmount('')
      setNote('')
      queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      queryClient.invalidateQueries({ queryKey: ['cash-balance'] })
      queryClient.invalidateQueries({ queryKey: ['mmf-balance'] })
      queryClient.invalidateQueries({ queryKey: ['stock-positions'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Spend failed')
    } finally {
      setSubmitting(false)
    }
  }

  const sources: { key: SourceBucket; label: string; balance: string }[] = [
    { key: 'cash', label: 'Cash', balance: formatMoney(cash) },
    { key: 'mmf', label: 'MMF', balance: formatMoney(mmf) },
    { key: 'stock', label: 'Stock', balance: `${positions.length} positions` },
  ]

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-bold">Record Spending</h1>
      <p className="mt-1 text-sm text-gray-500">
        When a kid buys something with their money
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">
            {success}
          </div>
        )}

        <KidSelector value={kidId} onChange={setKidId} />

        {/* Source bucket */}
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Spend from
          </label>
          <div className="mt-2 flex gap-2">
            {sources.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  setSource(s.key)
                  setTicker('')
                }}
                className={`flex-1 rounded-lg px-3 py-3 text-center text-sm font-medium transition-colors ${
                  source === s.key
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <div>{s.label}</div>
                <div className="text-xs opacity-80">{s.balance}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Stock ticker selector (conditional) */}
        {source === 'stock' && positions.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Which stock?
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              {positions.map((pos) => (
                <button
                  key={pos.ticker}
                  type="button"
                  onClick={() => setTicker(pos.ticker)}
                  className={`rounded-full px-4 py-2 text-sm font-medium ${
                    ticker === pos.ticker
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {pos.ticker} ({formatMoney(pos.current_value)})
                </button>
              ))}
            </div>
          </div>
        )}

        <MoneyInput
          id="spend-amount"
          label="Amount"
          value={amount}
          onChange={setAmount}
        />

        <div>
          <label
            htmlFor="what-for"
            className="block text-sm font-medium text-gray-700"
          >
            What for? (required)
          </label>
          <input
            id="what-for"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            required
            className="mt-1 block w-full rounded-md border border-gray-300 py-3 px-3 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            placeholder="Pokemon cards, toy, ice cream..."
          />
        </div>

        <button
          type="submit"
          disabled={submitting || !kidId || !note.trim()}
          className="w-full rounded-md bg-red-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:bg-red-700 focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Recording...' : 'Record Spending'}
        </button>
      </form>
    </div>
  )
}
