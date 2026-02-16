import { supabase } from './supabase'

interface FetchResult {
  mode: string
  updated: string[]
  skipped: string[]
  failed: { ticker: string; error: string }[]
  rows_upserted: number
  message?: string
}

export async function refreshStockPrices(): Promise<FetchResult> {
  const { data, error } = await supabase.functions.invoke(
    'fetch-stock-prices',
    { body: { mode: 'daily' } },
  )
  if (error) throw error
  return data as FetchResult
}

export async function backfillStockHistory(
  tickers: string[],
): Promise<FetchResult> {
  const { data, error } = await supabase.functions.invoke(
    'fetch-stock-prices',
    { body: { mode: 'backfill', tickers } },
  )
  if (error) throw error
  return data as FetchResult
}

export async function getTrackedTickers(): Promise<string[]> {
  const { data, error } = await supabase
    .from('stock_positions')
    .select('ticker')
    .gt('shares', 0)
  if (error) throw error
  const tickerSet = new Set<string>()
  for (const row of data ?? []) {
    tickerSet.add(row.ticker)
  }
  return Array.from(tickerSet).sort()
}
