import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KidSelector } from '../components/KidSelector'
import { MoneyInput } from '../components/MoneyInput'
import { ConfirmAction } from '../components/ConfirmAction'
import { SuccessCard } from '../components/SuccessCard'
import { useActionFlow } from '../hooks/useActionFlow'
import {
  withdrawFromCash,
  getCashBalance,
  getMmfBalance,
  getStockPositions,
} from '../lib/transactions'
import { supabase } from '../lib/supabase'
import { formatMoney } from '../lib/format'

type SourceBucket = 'cash' | 'mmf' | 'stock'

export default function Spend() {
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const flow = useActionFlow()
  const [kidId, setKidId] = useState(searchParams.get('kid') ?? '')
  const [source, setSource] = useState<SourceBucket>('cash')
  const [ticker, setTicker] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

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

  const handleRequestConfirm = (e: React.FormEvent) => {
    e.preventDefault()
    const amt = parseFloat(amount)
    if (!amt || amt <= 0 || !kidId || !note.trim()) return

    if (source === 'stock' && !ticker) {
      flow.setError('Select a stock to sell from')
      return
    }

    const sourceLabel =
      source === 'cash' ? 'Cash' : source === 'mmf' ? 'MMF' : ticker
    const sourceBalance =
      source === 'cash'
        ? cash
        : source === 'mmf'
          ? mmf
          : positions.find((p) => p.ticker === ticker)?.current_value ?? 0

    flow.requestConfirmation({
      title: `Spend ${formatMoney(amt)} from ${sourceLabel}`,
      details: [`For: ${note}`],
      balanceImpact: `${sourceLabel}: ${formatMoney(sourceBalance)} → ${formatMoney(sourceBalance - amt)}`,
      warning: sourceBalance < amt ? 'Insufficient balance' : undefined,
    })
  }

  const handleConfirm = () => {
    const amt = parseFloat(amount)
    flow.confirm(async () => {
      if (source === 'cash') {
        await withdrawFromCash(kidId, amt, note)
        invalidate()
        return `Spent ${formatMoney(amt)} from cash`
      } else if (source === 'mmf') {
        const { error } = await supabase.rpc('spend_from_mmf', {
          p_kid_id: kidId,
          p_amount: amt,
          p_note: note,
        })
        if (error) throw error
        invalidate()
        return `Spent ${formatMoney(amt)} from MMF`
      } else {
        const { data, error } = await supabase.rpc('spend_from_stock', {
          p_kid_id: kidId,
          p_ticker: ticker,
          p_amount: amt,
          p_note: note,
        })
        if (error) throw error
        const result = data as { shares_sold: number; realized_gain_loss: number }[] | null
        const gain = result?.[0]?.realized_gain_loss ?? 0
        invalidate()
        return `Spent ${formatMoney(amt)} from ${ticker}${gain !== 0 ? ` (${gain >= 0 ? 'gained' : 'lost'} ${formatMoney(Math.abs(gain))})` : ''}`
      }
    })
  }

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['portfolio'] })
    queryClient.invalidateQueries({ queryKey: ['cash-balance'] })
    queryClient.invalidateQueries({ queryKey: ['mmf-balance'] })
    queryClient.invalidateQueries({ queryKey: ['stock-positions'] })
  }

  const handleDoAnother = () => {
    setAmount('')
    setNote('')
    flow.reset()
  }

  const sources: { key: SourceBucket; label: string; balance: string }[] = [
    { key: 'cash', label: 'Cash', balance: formatMoney(cash) },
    { key: 'mmf', label: 'MMF', balance: formatMoney(mmf) },
    { key: 'stock', label: 'Stock', balance: `${positions.length} positions` },
  ]

  // Success state replaces the entire form
  if (flow.phase === 'success') {
    return (
      <div className="mx-auto max-w-lg">
        <h1 className="text-2xl font-bold">Record Spending</h1>
        <p className="mt-1 text-sm text-gray-500">
          When a kid buys something with their money
        </p>
        <div className="mt-6">
          <SuccessCard
            message={flow.result!}
            kidId={kidId}
            onDoAnother={handleDoAnother}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-bold">Record Spending</h1>
      <p className="mt-1 text-sm text-gray-500">
        When a kid buys something with their money
      </p>

      {/* Confirmation state replaces the submit button area */}
      {flow.phase === 'confirming' && flow.summary ? (
        <div className="mt-6">
          <ConfirmAction
            summary={flow.summary}
            variant="destructive"
            isSubmitting={flow.isSubmitting}
            error={flow.error}
            onConfirm={handleConfirm}
            onCancel={flow.cancel}
          />
        </div>
      ) : (
        <form onSubmit={handleRequestConfirm} className="mt-6 space-y-5">
          {flow.error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
              {flow.error}
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

          {(!kidId || !note.trim()) && (
            <p className="text-sm text-gray-400">
              {!kidId && !note.trim()
                ? 'Select a kid and describe what it\'s for'
                : !kidId
                  ? 'Select a kid to continue'
                  : 'Describe what the spending is for'}
            </p>
          )}

          <button
            type="submit"
            disabled={!kidId || !note.trim()}
            className="w-full rounded-md bg-red-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:bg-red-700 focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Record Spending
          </button>
        </form>
      )}
    </div>
  )
}
