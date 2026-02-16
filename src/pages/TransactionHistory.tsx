import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(Math.abs(n))
}

type BucketFilter = 'all' | 'cash' | 'mmf' | 'cd' | 'stock'

const FILTERS: { key: BucketFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'cash', label: 'Cash' },
  { key: 'mmf', label: 'MMF' },
  { key: 'cd', label: 'CD' },
  { key: 'stock', label: 'Stocks' },
]

const BUCKET_COLORS: Record<string, string> = {
  cash: 'bg-blue-100 text-blue-700',
  mmf: 'bg-emerald-100 text-emerald-700',
  cd: 'bg-amber-100 text-amber-700',
  stock: 'bg-purple-100 text-purple-700',
}

const TYPE_ICONS: Record<string, string> = {
  deposit: '+',
  withdrawal: '-',
  transfer_in: '+',
  transfer_out: '-',
  interest: '+',
  dividend: '+',
  fee: '-',
  penalty: '-',
}

function groupByDate(
  transactions: { created_at: string }[],
): { label: string; items: typeof transactions }[] {
  const now = new Date()
  const today = now.toDateString()
  const yesterday = new Date(now.getTime() - 86400000).toDateString()
  const weekAgo = new Date(now.getTime() - 7 * 86400000)

  const groups: Record<string, typeof transactions> = {}
  const order: string[] = []

  for (const tx of transactions) {
    const date = new Date(tx.created_at)
    let label: string

    if (date.toDateString() === today) {
      label = 'Today'
    } else if (date.toDateString() === yesterday) {
      label = 'Yesterday'
    } else if (date > weekAgo) {
      label = 'This Week'
    } else {
      label = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    }

    if (!groups[label]) {
      groups[label] = []
      order.push(label)
    }
    groups[label].push(tx)
  }

  return order.map((label) => ({ label, items: groups[label] }))
}

const PAGE_SIZE = 50

export default function TransactionHistory() {
  const { kidId } = useParams<{ kidId: string }>()
  const [filter, setFilter] = useState<BucketFilter>('all')
  const [limit, setLimit] = useState(PAGE_SIZE)

  const { data: kid } = useQuery({
    queryKey: ['kid', kidId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('kids')
        .select('name')
        .eq('id', kidId!)
        .single()
      if (error) throw error
      return data
    },
    enabled: !!kidId,
  })

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['transactions', kidId, filter, limit],
    queryFn: async () => {
      let query = supabase
        .from('transactions')
        .select('*')
        .eq('kid_id', kidId!)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (filter !== 'all') {
        query = query.eq('bucket', filter)
      }

      const { data, error } = await query
      if (error) throw error
      return data ?? []
    },
    enabled: !!kidId,
  })

  if (!kidId) return <p>No kid selected</p>

  const groups = groupByDate(transactions)
  const hasMore = transactions.length === limit

  return (
    <div className="mx-auto max-w-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            {kid?.name ?? '...'}'s History
          </h1>
          <p className="mt-1 text-sm text-gray-500">Transaction log</p>
        </div>
        <Link
          to="/"
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          Back
        </Link>
      </div>

      {/* Filter pills */}
      <div className="mt-4 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => {
              setFilter(f.key)
              setLimit(PAGE_SIZE)
            }}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === f.key
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Transaction list */}
      {isLoading ? (
        <div className="mt-6 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      ) : transactions.length === 0 ? (
        <p className="mt-8 text-center text-sm text-gray-400">
          No transactions yet
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {groups.map((group) => (
            <div key={group.label}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                {group.label}
              </h3>
              <div className="mt-2 space-y-1">
                {group.items.map((tx) => {
                  const amount = Number(tx.amount)
                  const isInflow = amount > 0
                  return (
                    <div
                      key={tx.id}
                      className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-gray-50"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${
                            isInflow
                              ? 'bg-emerald-100 text-emerald-600'
                              : 'bg-red-100 text-red-600'
                          }`}
                        >
                          {TYPE_ICONS[tx.type] ?? (isInflow ? '+' : '-')}
                        </span>
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {tx.note || tx.type}
                          </p>
                          <p className="text-xs text-gray-400">
                            {new Date(tx.created_at).toLocaleTimeString([], {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-semibold ${
                            isInflow ? 'text-emerald-600' : 'text-red-600'
                          }`}
                        >
                          {isInflow ? '+' : '-'}
                          {formatMoney(amount)}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            BUCKET_COLORS[tx.bucket] ?? 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {tx.bucket}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          {hasMore && (
            <button
              onClick={() => setLimit((prev) => prev + PAGE_SIZE)}
              className="w-full rounded-md border border-gray-300 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  )
}
