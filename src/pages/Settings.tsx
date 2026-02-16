import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { getKids } from '../lib/kids'
import { accrueMmfInterest } from '../lib/transactions'
import { refreshStockPrices } from '../lib/stock-prices'
import { extractErrorMessage } from '../lib/errors'
import { ConfirmAction } from '../components/ConfirmAction'
import { useActionFlow } from '../hooks/useActionFlow'

interface SettingRow {
  key: string
  value: string
  updated_at: string
}

const SETTING_DEFS = [
  {
    key: 'mmf_apy',
    label: 'MMF APY',
    suffix: '%',
    toDisplay: (v: string) => (parseFloat(v) * 100).toFixed(1),
    toStorage: (v: string) => (parseFloat(v) / 100).toString(),
    validate: (v: string) => {
      const n = parseFloat(v)
      return n >= 0 && n <= 20
    },
  },
  {
    key: 'cd_3m_apy',
    label: 'CD 3-month APY',
    suffix: '%',
    toDisplay: (v: string) => (parseFloat(v) * 100).toFixed(1),
    toStorage: (v: string) => (parseFloat(v) / 100).toString(),
    validate: (v: string) => {
      const n = parseFloat(v)
      return n >= 0 && n <= 20
    },
  },
  {
    key: 'cd_6m_apy',
    label: 'CD 6-month APY',
    suffix: '%',
    toDisplay: (v: string) => (parseFloat(v) * 100).toFixed(1),
    toStorage: (v: string) => (parseFloat(v) / 100).toString(),
    validate: (v: string) => {
      const n = parseFloat(v)
      return n >= 0 && n <= 20
    },
  },
  {
    key: 'cd_12m_apy',
    label: 'CD 12-month APY',
    suffix: '%',
    toDisplay: (v: string) => (parseFloat(v) * 100).toFixed(1),
    toStorage: (v: string) => (parseFloat(v) / 100).toString(),
    validate: (v: string) => {
      const n = parseFloat(v)
      return n >= 0 && n <= 20
    },
  },
  {
    key: 'stock_position_limit',
    label: 'Stock position limit per kid',
    suffix: '',
    toDisplay: (v: string) => v,
    toStorage: (v: string) => v,
    validate: (v: string) => {
      const n = parseInt(v)
      return n >= 1 && n <= 10
    },
  },
  {
    key: 'hanzi_dojo_conversion_rate',
    label: 'Hanzi Dojo rate ($/point)',
    suffix: '',
    toDisplay: (v: string) => v,
    toStorage: (v: string) => v,
    validate: (v: string) => {
      const n = parseFloat(v)
      return n >= 0.01 && n <= 10
    },
  },
]

export default function Settings() {
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const accrueFlow = useActionFlow()

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const { data, error } = await supabase.from('settings').select('*')
      if (error) throw error
      return data as SettingRow[]
    },
    staleTime: Infinity,
  })

  const { data: kids } = useQuery({
    queryKey: ['kids'],
    queryFn: getKids,
  })

  // Initialize form values when settings load
  useEffect(() => {
    if (settings) {
      const map: Record<string, string> = {}
      for (const s of settings) {
        const def = SETTING_DEFS.find((d) => d.key === s.key)
        map[s.key] = def ? def.toDisplay(s.value) : s.value
      }
      setValues(map)
    }
  }, [settings])

  const handleSave = async () => {
    setError(null)
    setSuccess(null)
    setSaving(true)

    try {
      for (const def of SETTING_DEFS) {
        const displayVal = values[def.key]
        if (displayVal === undefined) continue

        if (!def.validate(displayVal)) {
          setError(`Invalid value for ${def.label}`)
          setSaving(false)
          return
        }

        const storageVal = def.toStorage(displayVal)
        const { error } = await supabase
          .from('settings')
          .update({ value: storageVal })
          .eq('key', def.key)
        if (error) throw error
      }

      setSuccess('Settings saved')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      queryClient.invalidateQueries({ queryKey: ['simulator-settings'] })
    } catch (err) {
      setError(extractErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRefreshPrices = async () => {
    setRefreshing(true)
    setError(null)
    try {
      const result = await refreshStockPrices()
      setSuccess(
        `Prices refreshed: ${result.updated.length} updated, ${result.skipped.length} skipped, ${result.failed.length} failed`,
      )
    } catch (err) {
      setError(extractErrorMessage(err))
    } finally {
      setRefreshing(false)
    }
  }

  const handleRequestAccrue = () => {
    const kidNames = (kids ?? []).map((k) => k.name).join(', ')
    accrueFlow.requestConfirmation({
      title: 'Accrue MMF Interest',
      details: [`For all kids: ${kidNames}`],
      balanceImpact: 'Interest will be credited to each kid\'s MMF balance',
    })
  }

  const handleConfirmAccrue = () => {
    accrueFlow.confirm(async () => {
      const results = []
      for (const kid of kids ?? []) {
        const result = await accrueMmfInterest(kid.id)
        const credited = result?.[0]?.interest_credited ?? 0
        results.push(`${kid.name}: $${credited.toFixed(2)}`)
      }
      queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      return `Interest accrued — ${results.join(', ')}`
    })
  }

  const lastRefresh = settings?.find(
    (s) => s.key === 'last_price_refresh',
  )?.value

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-bold">Settings</h1>

      {error && (
        <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">
          {success}
        </div>
      )}

      {/* Rates & Limits */}
      <div className="mt-6 space-y-4">
        {SETTING_DEFS.map((def) => (
          <div key={def.key}>
            <label className="block text-sm font-medium text-gray-700">
              {def.label}
            </label>
            <div className="relative mt-1">
              <input
                type="text"
                inputMode="decimal"
                value={values[def.key] ?? ''}
                onChange={(e) =>
                  setValues((prev) => ({
                    ...prev,
                    [def.key]: e.target.value,
                  }))
                }
                className="block w-full rounded-md border border-gray-300 py-2 px-3 pr-10 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              />
              {def.suffix && (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                  {def.suffix}
                </span>
              )}
            </div>
            {settings && (
              <p className="mt-0.5 text-xs text-gray-400">
                Last updated:{' '}
                {new Date(
                  settings.find((s) => s.key === def.key)?.updated_at ?? '',
                ).toLocaleDateString()}
              </p>
            )}
          </div>
        ))}

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {/* Actions */}
      <div className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">Actions</h2>

        <div className="rounded-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Refresh Stock Prices</p>
              {lastRefresh && (
                <p className="text-xs text-gray-500">
                  Last: {new Date(lastRefresh).toLocaleString()}
                </p>
              )}
            </div>
            <button
              onClick={handleRefreshPrices}
              disabled={refreshing}
              className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 p-4">
          {accrueFlow.phase === 'confirming' && accrueFlow.summary ? (
            <ConfirmAction
              summary={accrueFlow.summary}
              isSubmitting={accrueFlow.isSubmitting}
              error={accrueFlow.error}
              onConfirm={handleConfirmAccrue}
              onCancel={accrueFlow.cancel}
            />
          ) : accrueFlow.phase === 'success' ? (
            <div className="text-center">
              <p className="text-sm font-medium text-emerald-700">
                {accrueFlow.result}
              </p>
              <button
                onClick={accrueFlow.reset}
                className="mt-2 text-sm text-blue-600 hover:text-blue-700"
              >
                Done
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Accrue MMF Interest</p>
                <p className="text-xs text-gray-500">
                  Credits earned interest for all kids
                </p>
              </div>
              <button
                onClick={handleRequestAccrue}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                Accrue
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
