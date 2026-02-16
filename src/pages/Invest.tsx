import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MoneyInput } from '../components/MoneyInput'
import { ConfirmAction } from '../components/ConfirmAction'
import { SuccessCard } from '../components/SuccessCard'
import { useActionFlow } from '../hooks/useActionFlow'
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
import { formatMoney } from '../lib/format'

function gainColor(n: number): string {
  if (n > 0) return 'text-emerald-600'
  if (n < 0) return 'text-red-600'
  return 'text-gray-500'
}

// ============================================================
// MMF Section
// ============================================================

function MmfSection({ kidId }: { kidId: string }) {
  const queryClient = useQueryClient()
  const flow = useActionFlow()
  const [investAmount, setInvestAmount] = useState('')
  const [redeemAmount, setRedeemAmount] = useState('')
  // Track which action was requested so confirm() knows what to do
  const [pendingAction, setPendingAction] = useState<'invest' | 'redeem' | null>(null)

  const { data: mmfBalance = 0 } = useQuery({
    queryKey: ['mmf-balance', kidId],
    queryFn: () => getMmfBalance(kidId),
  })

  const { data: cashBalance = 0 } = useQuery({
    queryKey: ['cash-balance', kidId],
    queryFn: () => getCashBalance(kidId),
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

  const handleRequestInvest = () => {
    const amt = parseFloat(investAmount)
    if (!amt || amt <= 0) return
    setPendingAction('invest')
    flow.requestConfirmation({
      title: `Invest ${formatMoney(amt)} in MMF`,
      details: [],
      balanceImpact: `Cash: ${formatMoney(cashBalance)} → ${formatMoney(cashBalance - amt)} | MMF: ${formatMoney(mmfBalance)} → ${formatMoney(mmfBalance + amt)}`,
      warning: cashBalance < amt ? 'Insufficient cash balance' : undefined,
    })
  }

  const handleRequestRedeem = () => {
    const amt = parseFloat(redeemAmount)
    if (!amt || amt <= 0) return
    setPendingAction('redeem')
    flow.requestConfirmation({
      title: `Withdraw ${formatMoney(amt)} from MMF`,
      details: [],
      balanceImpact: `MMF: ${formatMoney(mmfBalance)} → ${formatMoney(mmfBalance - amt)} | Cash: ${formatMoney(cashBalance)} → ${formatMoney(cashBalance + amt)}`,
      warning: mmfBalance < amt ? 'Insufficient MMF balance' : undefined,
    })
  }

  const handleConfirm = () => {
    flow.confirm(async () => {
      if (pendingAction === 'invest') {
        const amt = parseFloat(investAmount)
        const result = await investInMmf(kidId, amt)
        invalidate()
        return `Invested ${formatMoney(amt)} in MMF. Cash: ${formatMoney(result?.[0]?.cash_balance ?? 0)} | MMF: ${formatMoney(result?.[0]?.mmf_balance ?? 0)}`
      } else {
        const amt = parseFloat(redeemAmount)
        const result = await redeemFromMmf(kidId, amt)
        invalidate()
        return `Withdrew ${formatMoney(amt)} from MMF. Cash: ${formatMoney(result?.[0]?.cash_balance ?? 0)} | MMF: ${formatMoney(result?.[0]?.mmf_balance ?? 0)}`
      }
    })
  }

  const handleDoAnother = () => {
    setInvestAmount('')
    setRedeemAmount('')
    setPendingAction(null)
    flow.reset()
  }

  if (flow.phase === 'success') {
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-base font-semibold">Money Market Fund</h3>
        <div className="mt-3">
          <SuccessCard message={flow.result!} kidId={kidId} onDoAnother={handleDoAnother} />
        </div>
      </section>
    )
  }

  if (flow.phase === 'confirming' && flow.summary) {
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-base font-semibold">Money Market Fund</h3>
        <div className="mt-3">
          <ConfirmAction
            summary={flow.summary}
            variant={pendingAction === 'redeem' ? 'destructive' : 'default'}
            isSubmitting={flow.isSubmitting}
            error={flow.error}
            onConfirm={handleConfirm}
            onCancel={flow.cancel}
          />
        </div>
      </section>
    )
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

      {flow.error && (
        <p className="mt-2 text-sm text-red-600">{flow.error}</p>
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
            onClick={handleRequestInvest}
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
            onClick={handleRequestRedeem}
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
// CD Section
// ============================================================

function CdSection({ kidId }: { kidId: string }) {
  const queryClient = useQueryClient()
  const flow = useActionFlow()
  const [cdAmount, setCdAmount] = useState('')
  const [cdTerm, setCdTerm] = useState(3)
  const [pendingAction, setPendingAction] = useState<
    { type: 'create' } | { type: 'mature'; lotId: string } | { type: 'break'; lotId: string } | null
  >(null)

  const { data: lots = [] } = useQuery({
    queryKey: ['cd-lots', kidId],
    queryFn: () => getCdLots(kidId),
  })

  const { data: cashBalance = 0 } = useQuery({
    queryKey: ['cash-balance', kidId],
    queryFn: () => getCashBalance(kidId),
  })

  const activeLots = lots.filter((l) => l.status === 'active')

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['portfolio'] })
    queryClient.invalidateQueries({ queryKey: ['cash-balance'] })
    queryClient.invalidateQueries({ queryKey: ['cd-lots'] })
  }

  const handleRequestCreate = () => {
    const amt = parseFloat(cdAmount)
    if (!amt || amt <= 0) return
    setPendingAction({ type: 'create' })
    flow.requestConfirmation({
      title: `Lock ${formatMoney(amt)} in a ${cdTerm}-month CD`,
      details: [`Term: ${cdTerm} months`],
      balanceImpact: `Cash: ${formatMoney(cashBalance)} → ${formatMoney(cashBalance - amt)}`,
      warning: cashBalance < amt ? 'Insufficient cash balance' : undefined,
    })
  }

  const handleRequestMature = (lotId: string, principal: number) => {
    setPendingAction({ type: 'mature', lotId })
    flow.requestConfirmation({
      title: `Collect matured CD`,
      details: [`Principal: ${formatMoney(principal)}`],
      balanceImpact: 'Principal + interest will be returned to cash',
    })
  }

  const handleRequestBreak = (lotId: string, principal: number) => {
    setPendingAction({ type: 'break', lotId })
    flow.requestConfirmation({
      title: `Break CD early`,
      details: [`Principal: ${formatMoney(principal)}`],
      warning: 'Early withdrawal penalty will apply',
    })
  }

  const handleConfirm = () => {
    flow.confirm(async () => {
      if (!pendingAction) throw new Error('No pending action')
      if (pendingAction.type === 'create') {
        const amt = parseFloat(cdAmount)
        const result = await createCd(kidId, amt, cdTerm)
        invalidate()
        return `Locked ${formatMoney(amt)} in a ${cdTerm}-month CD. Matures ${result?.[0]?.maturity_date ?? 'soon'}`
      } else if (pendingAction.type === 'mature') {
        const result = await matureCd(pendingAction.lotId)
        const r = result?.[0]
        invalidate()
        return `CD collected! Principal: ${formatMoney(r?.principal_returned ?? 0)} + Interest: ${formatMoney(r?.interest_earned ?? 0)} = ${formatMoney(r?.total_returned ?? 0)} returned to cash`
      } else {
        const result = await breakCd(pendingAction.lotId)
        const r = result?.[0]
        invalidate()
        return `CD broken early. ${formatMoney(r?.net_returned ?? 0)} returned to cash (penalty: ${formatMoney(r?.penalty ?? 0)})`
      }
    })
  }

  const handleDoAnother = () => {
    setCdAmount('')
    setPendingAction(null)
    flow.reset()
  }

  const isMatured = (lot: { maturity_date: string }) =>
    new Date(lot.maturity_date) <= new Date()

  const daysRemaining = (lot: { maturity_date: string }) => {
    const diff = new Date(lot.maturity_date).getTime() - Date.now()
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
  }

  if (flow.phase === 'success') {
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-base font-semibold">Certificates of Deposit</h3>
        <div className="mt-3">
          <SuccessCard message={flow.result!} kidId={kidId} onDoAnother={handleDoAnother} />
        </div>
      </section>
    )
  }

  if (flow.phase === 'confirming' && flow.summary) {
    const isDestructive = pendingAction?.type === 'break'
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-base font-semibold">Certificates of Deposit</h3>
        <div className="mt-3">
          <ConfirmAction
            summary={flow.summary}
            variant={isDestructive ? 'destructive' : 'default'}
            isSubmitting={flow.isSubmitting}
            error={flow.error}
            onConfirm={handleConfirm}
            onCancel={flow.cancel}
          />
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h3 className="text-base font-semibold">Certificates of Deposit</h3>

      {flow.error && <p className="mt-2 text-sm text-red-600">{flow.error}</p>}

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
                    onClick={() => handleRequestMature(lot.id, Number(lot.principal))}
                    className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                  >
                    Collect
                  </button>
                ) : (
                  <button
                    onClick={() => handleRequestBreak(lot.id, Number(lot.principal))}
                    className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
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
            onClick={handleRequestCreate}
            className="mt-6 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
          >
            Lock it up
          </button>
        </div>
      </div>
    </section>
  )
}

// ============================================================
// Stock Section
// ============================================================

function StockSection({ kidId }: { kidId: string }) {
  const queryClient = useQueryClient()
  const flow = useActionFlow()
  const [buyTicker, setBuyTicker] = useState('')
  const [buyAmount, setBuyAmount] = useState('')
  const [sellAmounts, setSellAmounts] = useState<Record<string, string>>({})
  const [pendingAction, setPendingAction] = useState<
    { type: 'buy' } | { type: 'sell'; ticker: string; sellAll: boolean } | null
  >(null)

  const { data: positions = [] } = useQuery({
    queryKey: ['stock-positions', kidId],
    queryFn: () => getStockPositions(kidId),
  })

  const { data: cashBalance = 0 } = useQuery({
    queryKey: ['cash-balance', kidId],
    queryFn: () => getCashBalance(kidId),
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

  const handleRequestBuy = () => {
    const amt = parseFloat(buyAmount)
    if (!buyTicker || !amt || amt <= 0) return
    setPendingAction({ type: 'buy' })
    flow.requestConfirmation({
      title: `Buy ${formatMoney(amt)} of ${buyTicker.toUpperCase()}`,
      details: [],
      balanceImpact: `Cash: ${formatMoney(cashBalance)} → ${formatMoney(cashBalance - amt)}`,
      warning: cashBalance < amt ? 'Insufficient cash balance' : undefined,
    })
  }

  const handleRequestSell = (ticker: string, sellAll: boolean) => {
    const amt = sellAll ? 0 : parseFloat(sellAmounts[ticker] ?? '0')
    if (!sellAll && (!amt || amt <= 0)) return
    const pos = positions.find((p) => p.ticker === ticker)
    setPendingAction({ type: 'sell', ticker, sellAll })
    flow.requestConfirmation({
      title: sellAll
        ? `Sell all ${ticker} (${formatMoney(pos?.current_value ?? 0)})`
        : `Sell ${formatMoney(amt)} of ${ticker}`,
      details: [
        `Current value: ${formatMoney(pos?.current_value ?? 0)}`,
        `Gain/loss: ${formatMoney(pos?.gain_loss ?? 0)}`,
      ],
      warning: sellAll ? 'This will close your entire position' : undefined,
    })
  }

  const handleConfirm = () => {
    flow.confirm(async () => {
      if (!pendingAction) throw new Error('No pending action')
      if (pendingAction.type === 'buy') {
        const amt = parseFloat(buyAmount)
        const result = await buyStock(kidId, buyTicker.toUpperCase(), amt)
        const r = result?.[0]
        invalidate()
        return `Bought ${r?.shares_bought?.toFixed(4) ?? '?'} shares of ${buyTicker.toUpperCase()} at ${formatMoney(r?.price_per_share ?? 0)}/share`
      } else {
        const { ticker, sellAll } = pendingAction
        const amt = sellAll ? 0 : parseFloat(sellAmounts[ticker] ?? '0')
        const result = await sellStock(kidId, ticker, amt)
        const r = result?.[0]
        invalidate()
        return `Sold ${r?.shares_sold?.toFixed(4) ?? '?'} shares of ${ticker}. Proceeds: ${formatMoney(r?.proceeds ?? 0)} (${(r?.realized_gain_loss ?? 0) >= 0 ? '+' : ''}${formatMoney(r?.realized_gain_loss ?? 0)})`
      }
    })
  }

  const handleDoAnother = () => {
    setBuyTicker('')
    setBuyAmount('')
    setSellAmounts({})
    setPendingAction(null)
    flow.reset()
  }

  const isStale = (pos: { current_price: number }) => pos.current_price === 0

  if (flow.phase === 'success') {
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-base font-semibold">Stocks & ETFs</h3>
        <div className="mt-3">
          <SuccessCard message={flow.result!} kidId={kidId} onDoAnother={handleDoAnother} />
        </div>
      </section>
    )
  }

  if (flow.phase === 'confirming' && flow.summary) {
    const isDestructive = pendingAction?.type === 'sell'
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-base font-semibold">Stocks & ETFs</h3>
        <div className="mt-3">
          <ConfirmAction
            summary={flow.summary}
            variant={isDestructive ? 'destructive' : 'default'}
            isSubmitting={flow.isSubmitting}
            error={flow.error}
            onConfirm={handleConfirm}
            onCancel={flow.cancel}
          />
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">Stocks & ETFs</h3>
        <span className="text-xs text-gray-500">
          {positions.length} of {positionLimit ?? 5} positions
        </span>
      </div>

      {flow.error && <p className="mt-2 text-sm text-red-600">{flow.error}</p>}

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
                  onClick={() => handleRequestSell(pos.ticker, false)}
                  className="rounded-md bg-gray-600 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700"
                >
                  Sell
                </button>
                <button
                  onClick={() => handleRequestSell(pos.ticker, true)}
                  className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
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
            onClick={handleRequestBuy}
            className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
          >
            Buy
          </button>
        </div>
      </div>
    </section>
  )
}

// ============================================================
// Invest Page (combines all sections)
// ============================================================

export default function Invest() {
  const { kidId } = useParams<{ kidId: string }>()

  const { data: kids, isLoading: kidsLoading } = useQuery({
    queryKey: ['kids'],
    queryFn: async () => {
      const { data } = await supabase.from('kids').select('*').order('name')
      return data ?? []
    },
  })

  const { data: cash = 0, isLoading: cashLoading } = useQuery({
    queryKey: ['cash-balance', kidId],
    queryFn: () => getCashBalance(kidId!),
    enabled: !!kidId,
  })

  const kidName = kids?.find((k) => k.id === kidId)?.name
  const isLoading = kidsLoading || cashLoading

  if (!kidId) return <p>No kid selected</p>

  if (isLoading) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="flex items-center justify-between">
          <div>
            <div className="h-8 w-48 animate-pulse rounded bg-gray-200" />
            <div className="mt-2 h-4 w-32 animate-pulse rounded bg-gray-200" />
          </div>
          <Link
            to="/"
            className="text-sm text-blue-600 hover:text-blue-700"
          >
            Back
          </Link>
        </div>
        <div className="mt-6 space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl border border-gray-200 bg-gray-50" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{kidName ?? 'Unknown'}'s Investments</h1>
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
