import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getKids } from '../lib/kids'
import { getPortfolioSummary } from '../lib/transactions'

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(n)
}

function BucketBar({ summary }: { summary: ReturnType<typeof usePortfolio>['data'] }) {
  if (!summary || summary.grand_total === 0) return null
  const total = summary.grand_total
  const segments = [
    { label: 'Cash', value: summary.cash, color: 'bg-blue-400' },
    { label: 'MMF', value: summary.mmf, color: 'bg-emerald-400' },
    { label: 'CD', value: summary.cd_total, color: 'bg-amber-400' },
    { label: 'Stocks', value: summary.stock_total, color: 'bg-purple-400' },
  ].filter((s) => s.value > 0)

  return (
    <div className="mt-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-gray-100">
        {segments.map((s) => (
          <div
            key={s.label}
            className={`${s.color}`}
            style={{ width: `${(s.value / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex gap-3 text-xs text-gray-500">
        {segments.map((s) => (
          <span key={s.label}>
            <span
              className={`mr-1 inline-block h-2 w-2 rounded-full ${s.color}`}
            />
            {s.label} {formatMoney(s.value)}
          </span>
        ))}
      </div>
    </div>
  )
}

function usePortfolio(kidId: string) {
  return useQuery({
    queryKey: ['portfolio', kidId],
    queryFn: () => getPortfolioSummary(kidId),
    enabled: !!kidId,
  })
}

function KidCard({ kid }: { kid: { id: string; name: string } }) {
  const { data: summary, isLoading } = usePortfolio(kid.id)

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{kid.name}</h2>
        {summary && (
          <span className="text-xl font-bold">
            {formatMoney(summary.grand_total)}
          </span>
        )}
      </div>

      {isLoading && (
        <p className="mt-2 text-sm text-gray-400">Loading...</p>
      )}

      {summary && <BucketBar summary={summary} />}

      {summary && (
        <div className="mt-4 grid grid-cols-4 gap-2 text-center text-xs">
          <div>
            <p className="text-gray-500">Cash</p>
            <p className="font-medium">{formatMoney(summary.cash)}</p>
          </div>
          <div>
            <p className="text-gray-500">MMF</p>
            <p className="font-medium">{formatMoney(summary.mmf)}</p>
          </div>
          <div>
            <p className="text-gray-500">CDs</p>
            <p className="font-medium">{formatMoney(summary.cd_total)}</p>
          </div>
          <div>
            <p className="text-gray-500">Stocks</p>
            <p className="font-medium">{formatMoney(summary.stock_total)}</p>
          </div>
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Link
          to={`/kid/${kid.id}/invest`}
          className="flex-1 rounded-lg bg-gray-100 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          Invest
        </Link>
        <Link
          to="/add-money"
          className="flex-1 rounded-lg bg-blue-50 py-2 text-center text-sm font-medium text-blue-700 hover:bg-blue-100"
        >
          Add Money
        </Link>
        <Link
          to="/spend"
          className="flex-1 rounded-lg bg-gray-100 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          Spend
        </Link>
        <Link
          to={`/kid/${kid.id}/history`}
          className="flex-1 rounded-lg bg-gray-100 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          History
        </Link>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { data: kids, isLoading } = useQuery({
    queryKey: ['kids'],
    queryFn: getKids,
  })

  return (
    <div>
      <h1 className="text-2xl font-bold">The Mini Mint</h1>
      <p className="mt-1 text-sm text-gray-500">Portfolio overview</p>

      {isLoading && <p className="mt-4 text-gray-400">Loading...</p>}

      <div className="mt-6 space-y-4">
        {(kids ?? []).map((kid) => (
          <KidCard key={kid.id} kid={kid} />
        ))}
      </div>
    </div>
  )
}
