import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KidSelector } from '../components/KidSelector'
import { MoneyInput } from '../components/MoneyInput'
import { ConfirmAction } from '../components/ConfirmAction'
import { SuccessCard } from '../components/SuccessCard'
import { useActionFlow } from '../hooks/useActionFlow'
import { depositToCash } from '../lib/transactions'
import { supabase } from '../lib/supabase'
import { formatMoney } from '../lib/format'

const SOURCES = [
  { key: 'chores', label: 'Chores' },
  { key: 'chinese_book', label: 'Chinese Book' },
  { key: 'english_book', label: 'English Book' },
  { key: 'hanzi_dojo', label: 'Hanzi Dojo Points' },
  { key: 'red_envelope', label: 'Red Envelope' },
  { key: 'gift', label: 'Gift' },
  { key: 'other', label: 'Other' },
]

export default function AddMoney() {
  const queryClient = useQueryClient()
  const flow = useActionFlow()
  const [kidId, setKidId] = useState('')
  const [source, setSource] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [pointsTotal, setPointsTotal] = useState('')

  const isHanziDojo = source === 'hanzi_dojo'

  // Fetch last Hanzi Dojo snapshot for this kid
  const { data: lastSnapshot } = useQuery({
    queryKey: ['hanzi-dojo-last', kidId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('transactions')
        .select('metadata')
        .eq('kid_id', kidId)
        .eq('type', 'deposit')
        .eq('bucket', 'cash')
        .not('metadata', 'is', null)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw error
      const hanziTx = (data ?? []).find(
        (t) => t.metadata && (t.metadata as Record<string, unknown>).source === 'hanzi_dojo',
      )
      if (!hanziTx) return null
      return {
        points_total: Number(
          (hanziTx.metadata as Record<string, unknown>).points_total ?? 0,
        ),
      }
    },
    enabled: isHanziDojo && !!kidId,
  })

  // Fetch conversion rate
  const { data: conversionRate } = useQuery({
    queryKey: ['hanzi-dojo-rate'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'hanzi_dojo_conversion_rate')
        .single()
      if (error) throw error
      return parseFloat(data.value)
    },
    enabled: isHanziDojo,
  })

  // Compute Hanzi Dojo delta
  const lastPoints = lastSnapshot?.points_total ?? 0
  const currentPoints = parseInt(pointsTotal) || 0
  const pointsDelta = currentPoints - lastPoints
  const hanziAmount =
    conversionRate && pointsDelta > 0
      ? Math.round(pointsDelta * conversionRate * 100) / 100
      : 0

  const handleRequestConfirm = (e: React.FormEvent) => {
    e.preventDefault()

    if (isHanziDojo) {
      if (pointsDelta <= 0) {
        flow.setError(
          pointsDelta === 0
            ? 'No new points since last entry. Nothing to deposit.'
            : `That's fewer points than last time (${lastPoints.toLocaleString()}). Did you mean something else?`,
        )
        return
      }
      flow.requestConfirmation({
        title: `Deposit ${formatMoney(hanziAmount)}`,
        details: [
          `${pointsDelta.toLocaleString()} new points × ${formatMoney(conversionRate!)}/point`,
          note ? `Note: ${note}` : '',
        ].filter(Boolean),
        balanceImpact: `Hanzi Dojo conversion → ${formatMoney(hanziAmount)} to cash`,
      })
    } else {
      const parsedAmount = parseFloat(amount)
      if (!parsedAmount || parsedAmount <= 0) {
        flow.setError('Enter a valid positive amount')
        return
      }
      const sourceLabel = SOURCES.find((s) => s.key === source)?.label ?? source
      flow.requestConfirmation({
        title: `Deposit ${formatMoney(parsedAmount)}`,
        details: [
          `Source: ${sourceLabel}`,
          note ? `Note: ${note}` : '',
        ].filter(Boolean),
      })
    }
  }

  const handleConfirm = () => {
    flow.confirm(async () => {
      if (isHanziDojo) {
        const result = await depositToCash(kidId, hanziAmount, note || undefined, 'hanzi_dojo', {
          points_total: currentPoints,
          points_delta: pointsDelta,
        })
        const newBalance = result?.[0]?.new_balance ?? 0
        invalidate()
        return `${pointsDelta.toLocaleString()} points → ${formatMoney(hanziAmount)} deposited. New cash balance: ${formatMoney(newBalance)}`
      } else {
        const parsedAmount = parseFloat(amount)
        const result = await depositToCash(kidId, parsedAmount, note || undefined, source)
        const newBalance = result?.[0]?.new_balance ?? 0
        invalidate()
        return `${formatMoney(parsedAmount)} deposited. New cash balance: ${formatMoney(newBalance)}`
      }
    })
  }

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['portfolio'] })
    queryClient.invalidateQueries({ queryKey: ['hanzi-dojo-last'] })
    queryClient.invalidateQueries({ queryKey: ['cash-balance'] })
  }

  const handleDoAnother = () => {
    setAmount('')
    setPointsTotal('')
    setNote('')
    flow.reset()
  }

  // Success state replaces the entire form
  if (flow.phase === 'success') {
    return (
      <div className="mx-auto max-w-lg">
        <h1 className="text-2xl font-bold">Add Money</h1>
        <p className="mt-1 text-sm text-gray-500">
          Record a deposit to a kid's cash balance
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
      <h1 className="text-2xl font-bold">Add Money</h1>
      <p className="mt-1 text-sm text-gray-500">
        Record a deposit to a kid's cash balance
      </p>

      {flow.phase === 'confirming' && flow.summary ? (
        <div className="mt-6">
          <ConfirmAction
            summary={flow.summary}
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

          {/* Source pills */}
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Source
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              {SOURCES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSource(s.key)}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                    source === s.key
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Conditional: Hanzi Dojo points mode vs dollar mode */}
          {isHanziDojo ? (
            <div className="space-y-3">
              <div className="rounded-md bg-blue-50 p-3 text-sm">
                {lastSnapshot
                  ? `Last recorded: ${lastPoints.toLocaleString()} points`
                  : 'First entry — full total will be counted as new points'}
              </div>
              <div>
                <label
                  htmlFor="points"
                  className="block text-sm font-medium text-gray-700"
                >
                  Current point total
                </label>
                <input
                  id="points"
                  type="text"
                  inputMode="numeric"
                  value={pointsTotal}
                  onChange={(e) => setPointsTotal(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 py-3 px-3 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                  placeholder="Enter current total"
                />
              </div>
              {currentPoints > 0 && pointsDelta > 0 && conversionRate && (
                <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">
                  {pointsDelta.toLocaleString()} new points ×{' '}
                  {formatMoney(conversionRate)}/point ={' '}
                  <strong>{formatMoney(hanziAmount)}</strong> deposit
                </div>
              )}
              {currentPoints > 0 && pointsDelta < 0 && (
                <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-700">
                  That's fewer points than last time (
                  {lastPoints.toLocaleString()}). Did you mean something else?
                </div>
              )}
              {currentPoints > 0 && pointsDelta === 0 && (
                <div className="rounded-md bg-gray-50 p-3 text-sm text-gray-600">
                  No new points since last entry. Nothing to deposit.
                </div>
              )}
            </div>
          ) : (
            <MoneyInput
              id="amount"
              label="Amount"
              value={amount}
              onChange={setAmount}
            />
          )}

          <div>
            <label
              htmlFor="note"
              className="block text-sm font-medium text-gray-700"
            >
              Note (optional)
            </label>
            <input
              id="note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              className="mt-1 block w-full rounded-md border border-gray-300 py-3 px-3 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              placeholder="What's this for?"
            />
          </div>

          {(!kidId || !source) && (
            <p className="text-sm text-gray-400">
              {!kidId && !source
                ? 'Select a kid and a source to continue'
                : !kidId
                  ? 'Select a kid to continue'
                  : 'Select a source to continue'}
            </p>
          )}

          <button
            type="submit"
            disabled={!kidId || !source}
            className="w-full rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isHanziDojo
              ? `Deposit ${hanziAmount > 0 ? formatMoney(hanziAmount) : ''}`
              : 'Deposit'}
          </button>
        </form>
      )}
    </div>
  )
}
