/**
 * Seed QA test kids with realistic balances.
 * Run: node scripts/seed-qa-kids.mjs
 *
 * Uses service role key to bypass RLS.
 * Creates two QA kids and seeds them with transactions
 * that produce realistic multi-bucket balances.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load env vars from .env.local
function loadEnv(filename) {
  const path = resolve(__dirname, '..', filename)
  try {
    const content = readFileSync(path, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const [key, ...rest] = trimmed.split('=')
      process.env[key] = rest.join('=')
    }
  } catch {
    // file doesn't exist, skip
  }
}

loadEnv('.env.local')
loadEnv('.env.test.local')

const supabaseUrl = process.env.VITE_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const testUserUuid = process.env.TEST_ADMIN_UUID

if (!supabaseUrl || !serviceRoleKey || !testUserUuid) {
  console.error('Missing env vars. Need VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_ADMIN_UUID')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ============================================================
// Helper: insert a transaction
// ============================================================
async function insertTx(kidId, type, bucket, amount, note, metadata = null) {
  const { error } = await supabase.from('transactions').insert({
    kid_id: kidId,
    type,
    bucket,
    amount,
    note,
    metadata,
    created_by: testUserUuid,
  })
  if (error) throw new Error(`Transaction failed: ${error.message}`)
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('Seeding QA kids...\n')

  // Check if QA kids already exist
  const { data: existingKids } = await supabase
    .from('kids')
    .select('id, name')
    .like('name', 'QA-%')

  if (existingKids && existingKids.length > 0) {
    console.log('QA kids already exist:')
    for (const k of existingKids) {
      console.log(`  ${k.name} (${k.id})`)
    }
    console.log('\nTo re-seed, delete them first. Exiting.')
    process.exit(0)
  }

  // Create two QA kids
  const QA_HOUSEHOLD_ID = 'aaaaaaaa-0000-0000-0000-000000000002'

  const { data: kids, error: kidsErr } = await supabase
    .from('kids')
    .insert([
      { name: 'QA-Alice', household_id: QA_HOUSEHOLD_ID },
      { name: 'QA-Bob', household_id: QA_HOUSEHOLD_ID },
    ])
    .select('id, name')

  if (kidsErr) throw kidsErr
  console.log('Created QA kids:')
  for (const k of kids) {
    console.log(`  ${k.name} (${k.id})`)
  }

  const alice = kids.find((k) => k.name === 'QA-Alice')
  const bob = kids.find((k) => k.name === 'QA-Bob')

  // ============================================================
  // QA-Alice: The active investor (diverse portfolio)
  //   Target: Cash ~$200, MMF ~$100, 1 active CD, 1 stock position
  // ============================================================
  console.log('\nSeeding QA-Alice...')

  // Deposits (cash inflows)
  await insertTx(alice.id, 'deposit', 'cash', 500.00, 'Birthday money from grandparents')
  await insertTx(alice.id, 'deposit', 'cash', 50.00, 'Weekly allowance', { source: 'allowance' })
  await insertTx(alice.id, 'deposit', 'cash', 25.00, 'Chores - cleaned room + dishes', { source: 'chores' })
  await insertTx(alice.id, 'deposit', 'cash', 15.00, 'Sold lemonade', { source: 'other' })

  // Spending (cash outflows)
  await insertTx(alice.id, 'withdraw', 'cash', -20.00, 'Pokemon cards')
  await insertTx(alice.id, 'withdraw', 'cash', -8.50, 'Ice cream with friends')
  await insertTx(alice.id, 'withdraw', 'cash', -12.00, 'Book fair')

  // MMF investment: move $150 from cash to MMF
  await insertTx(alice.id, 'invest', 'cash', -150.00, 'Move to MMF')
  await insertTx(alice.id, 'invest', 'mmf', 150.00, 'Move to MMF')

  // MMF interest earned
  await insertTx(alice.id, 'interest', 'mmf', 0.52, 'Monthly interest')

  // MMF partial redeem: move $50 back to cash
  await insertTx(alice.id, 'redeem', 'mmf', -50.00, 'Redeem from MMF')
  await insertTx(alice.id, 'redeem', 'cash', 50.00, 'Redeem from MMF')

  // CD: lock $50 in a 6-month CD
  const { data: cdLot, error: cdErr } = await supabase
    .from('cd_lots')
    .insert({
      kid_id: alice.id,
      principal: 50.00,
      apy: 0.05,
      term_months: 6,
      start_date: new Date().toISOString().split('T')[0],
      maturity_date: new Date(Date.now() + 180 * 86400000).toISOString().split('T')[0],
      status: 'active',
    })
    .select('id')
    .single()
  if (cdErr) throw cdErr

  // CD cash outflow
  await insertTx(alice.id, 'invest', 'cash', -50.00, 'Lock in 6-month CD', { cd_lot_id: cdLot.id })

  // Stock: buy $25 of AAPL at $190/share
  const aaplShares = 25.00 / 190.00
  await insertTx(alice.id, 'buy', 'cash', -25.00, 'Buy AAPL', { ticker: 'AAPL', shares: aaplShares, price_per_share: 190.00 })
  await insertTx(alice.id, 'buy', 'stock', 25.00, 'Buy AAPL', { ticker: 'AAPL', shares: aaplShares, price_per_share: 190.00 })

  // Create stock position
  const { error: posErr } = await supabase.from('stock_positions').insert({
    kid_id: alice.id,
    ticker: 'AAPL',
    shares: aaplShares,
    cost_basis: 25.00,
  })
  if (posErr) throw posErr

  // Ensure AAPL has a price entry
  const today = new Date().toISOString().split('T')[0]
  await supabase.from('stock_prices').upsert(
    { ticker: 'AAPL', date: today, close_price: 192.50 },
    { onConflict: 'ticker,date' }
  )

  console.log('  Alice seeded: ~$199.50 cash, ~$100.52 MMF, $50 CD, $25 stocks')

  // ============================================================
  // QA-Bob: The saver (simpler portfolio)
  //   Target: Cash ~$300, MMF ~$50, no CDs, no stocks
  // ============================================================
  console.log('\nSeeding QA-Bob...')

  // Deposits
  await insertTx(bob.id, 'deposit', 'cash', 250.00, 'Birthday money')
  await insertTx(bob.id, 'deposit', 'cash', 100.00, 'Lunar New Year red envelope')
  await insertTx(bob.id, 'deposit', 'cash', 30.00, 'Weekly allowance x3', { source: 'allowance' })

  // Spending
  await insertTx(bob.id, 'withdraw', 'cash', -15.00, 'Minecraft marketplace')
  await insertTx(bob.id, 'withdraw', 'cash', -5.00, 'Snacks')

  // MMF: move $50 to MMF
  await insertTx(bob.id, 'invest', 'cash', -50.00, 'Move to MMF')
  await insertTx(bob.id, 'invest', 'mmf', 50.00, 'Move to MMF')

  // Small interest
  await insertTx(bob.id, 'interest', 'mmf', 0.17, 'Monthly interest')

  console.log('  Bob seeded: ~$310.00 cash, ~$50.17 MMF')

  // ============================================================
  // Summary
  // ============================================================
  console.log('\n✓ QA kids seeded successfully!')
  console.log('\nQA-Alice ID:', alice.id)
  console.log('QA-Bob ID:', bob.id)
  console.log('\nLogin with testuser@familyapps.com to verify in the app.')
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
