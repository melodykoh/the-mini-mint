import { supabase } from './supabase'

// ============================================================
// T4: Deposit and Withdraw
// ============================================================

export async function depositToCash(
  kidId: string,
  amount: number,
  note?: string,
  source?: string,
  metadata?: Record<string, unknown>,
) {
  const { data, error } = await supabase.rpc('deposit_to_cash', {
    p_kid_id: kidId,
    p_amount: amount,
    p_note: note ?? null,
    p_source: source ?? null,
    p_metadata: metadata ?? null,
  })
  if (error) throw error
  return data as { new_balance: number }[]
}

export async function withdrawFromCash(
  kidId: string,
  amount: number,
  note?: string,
) {
  const { data, error } = await supabase.rpc('withdraw_from_cash', {
    p_kid_id: kidId,
    p_amount: amount,
    p_note: note ?? null,
  })
  if (error) throw error
  return data as { new_balance: number }[]
}

export async function getCashBalance(kidId: string): Promise<number> {
  const { data, error } = await supabase
    .from('transactions')
    .select('amount')
    .eq('kid_id', kidId)
    .eq('bucket', 'cash')
  if (error) throw error
  return (data ?? []).reduce((sum, row) => sum + Number(row.amount), 0)
}

// ============================================================
// T5: MMF
// ============================================================

export async function investInMmf(kidId: string, amount: number) {
  const { data, error } = await supabase.rpc('invest_in_mmf', {
    p_kid_id: kidId,
    p_amount: amount,
  })
  if (error) throw error
  return data as { cash_balance: number; mmf_balance: number }[]
}

export async function redeemFromMmf(kidId: string, amount: number) {
  const { data, error } = await supabase.rpc('redeem_from_mmf', {
    p_kid_id: kidId,
    p_amount: amount,
  })
  if (error) throw error
  return data as { cash_balance: number; mmf_balance: number }[]
}

export async function accrueMmfInterest(kidId: string) {
  const { data, error } = await supabase.rpc('accrue_mmf_interest', {
    p_kid_id: kidId,
  })
  if (error) throw error
  return data as { interest_credited: number; new_mmf_balance: number }[]
}

export async function getMmfBalance(kidId: string): Promise<number> {
  const { data, error } = await supabase
    .from('transactions')
    .select('amount')
    .eq('kid_id', kidId)
    .eq('bucket', 'mmf')
  if (error) throw error
  return (data ?? []).reduce((sum, row) => sum + Number(row.amount), 0)
}

// ============================================================
// T6: CD Lots
// ============================================================

export async function createCd(
  kidId: string,
  amount: number,
  termMonths: number,
) {
  const { data, error } = await supabase.rpc('create_cd', {
    p_kid_id: kidId,
    p_amount: amount,
    p_term_months: termMonths,
  })
  if (error) throw error
  return data as { cd_lot_id: string; maturity_date: string; apy: number }[]
}

export async function matureCd(cdLotId: string) {
  const { data, error } = await supabase.rpc('mature_cd', {
    p_cd_lot_id: cdLotId,
  })
  if (error) throw error
  return data as {
    principal_returned: number
    interest_earned: number
    total_returned: number
  }[]
}

export async function breakCd(cdLotId: string) {
  const { data, error } = await supabase.rpc('break_cd', {
    p_cd_lot_id: cdLotId,
  })
  if (error) throw error
  return data as {
    principal_returned: number
    interest_earned: number
    penalty: number
    net_returned: number
  }[]
}

export async function getCdLots(kidId: string) {
  const { data, error } = await supabase
    .from('cd_lots')
    .select('*')
    .eq('kid_id', kidId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

// ============================================================
// T7: Stock Positions
// ============================================================

export async function buyStock(
  kidId: string,
  ticker: string,
  dollarAmount: number,
) {
  const { data, error } = await supabase.rpc('buy_stock', {
    p_kid_id: kidId,
    p_ticker: ticker,
    p_dollar_amount: dollarAmount,
  })
  if (error) throw error
  return data as {
    shares_bought: number
    price_per_share: number
    new_cash_balance: number
  }[]
}

export async function sellStock(
  kidId: string,
  ticker: string,
  dollarAmount: number,
) {
  const { data, error } = await supabase.rpc('sell_stock', {
    p_kid_id: kidId,
    p_ticker: ticker,
    p_dollar_amount: dollarAmount,
  })
  if (error) throw error
  return data as {
    shares_sold: number
    price_per_share: number
    proceeds: number
    realized_gain_loss: number
    new_cash_balance: number
  }[]
}

export async function getStockPositions(kidId: string) {
  // Get positions
  const { data: positions, error: posError } = await supabase
    .from('stock_positions')
    .select('*')
    .eq('kid_id', kidId)
    .gt('shares', 0)
  if (posError) throw posError

  if (!positions || positions.length === 0) return []

  // Get latest prices for each ticker
  const tickers = positions.map((p) => p.ticker)
  const { data: prices, error: priceError } = await supabase
    .from('stock_prices')
    .select('ticker, close_price, date')
    .in('ticker', tickers)
    .order('date', { ascending: false })
  if (priceError) throw priceError

  // Get latest price per ticker (first row per ticker since sorted DESC)
  const latestPrices = new Map<string, number>()
  for (const p of prices ?? []) {
    if (!latestPrices.has(p.ticker)) {
      latestPrices.set(p.ticker, Number(p.close_price))
    }
  }

  return positions.map((pos) => {
    const currentPrice = latestPrices.get(pos.ticker) ?? 0
    const currentValue = Number(pos.shares) * currentPrice
    const gainLoss = currentValue - Number(pos.cost_basis)
    const gainLossPct =
      Number(pos.cost_basis) > 0 ? (gainLoss / Number(pos.cost_basis)) * 100 : 0
    return {
      ...pos,
      current_price: currentPrice,
      current_value: Math.round(currentValue * 100) / 100,
      gain_loss: Math.round(gainLoss * 100) / 100,
      gain_loss_pct: Math.round(gainLossPct * 100) / 100,
    }
  })
}

export async function getPortfolioSummary(kidId: string) {
  // Fire all balance queries in parallel
  const [cash, mmf, cdLots, stockPositions] = await Promise.all([
    getCashBalance(kidId),
    getMmfBalance(kidId),
    getCdLots(kidId),
    getStockPositions(kidId),
  ])

  const cdTotal = (cdLots ?? [])
    .filter((lot) => lot.status === 'active')
    .reduce((sum, lot) => sum + Number(lot.principal), 0)

  const stockTotal = (stockPositions ?? []).reduce(
    (sum, pos) => sum + pos.current_value,
    0,
  )

  return {
    cash: Math.round(cash * 100) / 100,
    mmf: Math.round(mmf * 100) / 100,
    cd_total: Math.round(cdTotal * 100) / 100,
    stock_total: Math.round(stockTotal * 100) / 100,
    grand_total:
      Math.round((cash + mmf + cdTotal + stockTotal) * 100) / 100,
  }
}
