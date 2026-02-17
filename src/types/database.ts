// Database types — manually maintained to match Supabase schema.
// Updated in T2 when schema is created.

export type TransactionType =
  | 'deposit'
  | 'withdraw'
  | 'invest'
  | 'redeem'
  | 'interest'
  | 'dividend'
  | 'buy'
  | 'sell'

export type TransactionBucket = 'cash' | 'mmf' | 'cd' | 'stock'

export type CdStatus = 'active' | 'matured' | 'broken'

export interface Kid {
  id: string
  name: string
  household_id: string
  created_at: string
}

export interface Transaction {
  id: string
  kid_id: string
  type: TransactionType
  bucket: TransactionBucket
  amount: number
  note: string | null
  metadata: Record<string, unknown> | null
  created_by: string
  created_at: string
}

export interface CdLot {
  id: string
  kid_id: string
  principal: number
  apy: number
  term_months: number
  start_date: string
  maturity_date: string
  status: CdStatus
  created_at: string
}

export interface StockPosition {
  id: string
  kid_id: string
  ticker: string
  shares: number
  cost_basis: number
  created_at: string
  updated_at: string
}

export interface StockPrice {
  ticker: string
  date: string
  close_price: number
  created_at: string
}

export interface Setting {
  key: string
  value: string
  updated_at: string
}

export interface AdminUser {
  user_id: string
  household_id: string
  created_at: string
}
