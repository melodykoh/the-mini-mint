// Supabase Edge Function: fetch-stock-prices
// Fetches stock prices from Twelve Data API and upserts into stock_prices table.
// Two modes: "daily" (latest prices) and "backfill" (5-year history).
//
// Deploy: supabase functions deploy fetch-stock-prices
// Set secret: supabase secrets set TWELVE_DATA_API_KEY=xxx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TWELVE_DATA_BASE = "https://api.twelvedata.com";

interface RequestBody {
  mode?: "daily" | "backfill";
  tickers?: string[]; // override tickers (for backfill of a specific new ticker)
}

interface PriceRow {
  ticker: string;
  date: string;
  close_price: number;
}

interface ResultSummary {
  mode: string;
  updated: string[];
  skipped: string[];
  failed: { ticker: string; error: string }[];
  rows_upserted: number;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only accept POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "TWELVE_DATA_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Create Supabase client with the caller's auth token
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization");

  // Use service role for DB writes, but verify caller is admin
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Verify the caller is an admin using their JWT
  if (authHeader) {
    const anonClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authError,
    } = await anonClient.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check admin_users table
    const { data: adminCheck } = await supabase
      .from("admin_users")
      .select("user_id")
      .eq("user_id", user.id)
      .single();

    if (!adminCheck) {
      return new Response(
        JSON.stringify({ error: "Forbidden: not an admin" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } else {
    return new Response(JSON.stringify({ error: "No auth token provided" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Parse request body
  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    // defaults are fine
  }

  const mode = body.mode ?? "daily";

  // Rate limit: check last refresh timestamp (daily mode only)
  if (mode === "daily") {
    const { data: lastRefresh } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "last_price_refresh")
      .single();

    if (lastRefresh) {
      const lastTime = new Date(lastRefresh.value).getTime();
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      if (lastTime > oneHourAgo) {
        return new Response(
          JSON.stringify({
            error: "Rate limited: prices were refreshed less than 1 hour ago",
            last_refresh: lastRefresh.value,
          }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }
  }

  // Get tickers to fetch
  let tickers: string[] = body.tickers ?? [];
  if (tickers.length === 0) {
    // Get all tracked tickers from stock_positions
    const { data: positions } = await supabase
      .from("stock_positions")
      .select("ticker")
      .gt("shares", 0);

    const tickerSet = new Set<string>();
    for (const p of positions ?? []) {
      tickerSet.add(p.ticker);
    }
    tickers = Array.from(tickerSet);
  }

  if (tickers.length === 0) {
    return new Response(
      JSON.stringify({
        mode,
        updated: [],
        skipped: [],
        failed: [],
        rows_upserted: 0,
        message: "No tickers to fetch",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const result: ResultSummary = {
    mode,
    updated: [],
    skipped: [],
    failed: [],
    rows_upserted: 0,
  };

  if (mode === "daily") {
    // Daily mode: batch fetch latest prices
    await fetchDailyPrices(apiKey, tickers, supabase, result);
  } else if (mode === "backfill") {
    // Backfill mode: fetch 5-year history per ticker
    for (const ticker of tickers) {
      await fetchHistoricalPrices(apiKey, ticker, supabase, result);
    }
  } else {
    return new Response(
      JSON.stringify({ error: `Invalid mode: ${mode}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Update last refresh timestamp (daily mode)
  if (mode === "daily" && result.updated.length > 0) {
    await supabase.from("settings").upsert(
      { key: "last_price_refresh", value: new Date().toISOString() },
      { onConflict: "key" },
    );
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

async function fetchDailyPrices(
  apiKey: string,
  tickers: string[],
  supabase: ReturnType<typeof createClient>,
  result: ResultSummary,
) {
  const symbolParam = tickers.join(",");
  const url = `${TWELVE_DATA_BASE}/time_series?symbol=${symbolParam}&interval=1day&outputsize=1&apikey=${apiKey}`;

  let data: Record<string, unknown>;
  try {
    const resp = await fetch(url);
    data = await resp.json();
  } catch (err) {
    for (const t of tickers) {
      result.failed.push({ ticker: t, error: String(err) });
    }
    return;
  }

  // Handle single vs batch response shape
  const tickerDataMap: Record<string, { values?: Array<{ datetime: string; close: string }>; status?: string; message?: string }> = {};

  if (tickers.length === 1) {
    tickerDataMap[tickers[0]] = data as typeof tickerDataMap[string];
  } else {
    Object.assign(tickerDataMap, data);
  }

  const rows: PriceRow[] = [];
  for (const ticker of tickers) {
    const td = tickerDataMap[ticker];
    if (!td || td.status === "error") {
      result.failed.push({
        ticker,
        error: td?.message ?? "No data returned",
      });
      continue;
    }

    const values = td.values;
    if (!values || values.length === 0) {
      result.skipped.push(ticker);
      continue;
    }

    for (const v of values) {
      rows.push({
        ticker,
        date: v.datetime,
        close_price: parseFloat(v.close),
      });
    }
    result.updated.push(ticker);
  }

  if (rows.length > 0) {
    const { error } = await supabase.from("stock_prices").upsert(rows, {
      onConflict: "ticker,date",
    });
    if (error) {
      console.error("Upsert error:", error);
    } else {
      result.rows_upserted += rows.length;
    }
  }
}

async function fetchHistoricalPrices(
  apiKey: string,
  ticker: string,
  supabase: ReturnType<typeof createClient>,
  result: ResultSummary,
) {
  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(
    Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .split("T")[0];

  const url = `${TWELVE_DATA_BASE}/time_series?symbol=${ticker}&interval=1day&start_date=${startDate}&end_date=${endDate}&apikey=${apiKey}`;

  let data: Record<string, unknown>;
  try {
    const resp = await fetch(url);
    data = await resp.json();
  } catch (err) {
    result.failed.push({ ticker, error: String(err) });
    return;
  }

  if ((data as { status?: string }).status === "error") {
    result.failed.push({
      ticker,
      error: (data as { message?: string }).message ?? "API error",
    });
    return;
  }

  const values = (data as { values?: Array<{ datetime: string; close: string }> }).values;
  if (!values || values.length === 0) {
    result.skipped.push(ticker);
    return;
  }

  // Batch upsert in chunks of 500 (Supabase row limit)
  const CHUNK_SIZE = 500;
  let totalUpserted = 0;

  for (let i = 0; i < values.length; i += CHUNK_SIZE) {
    const chunk = values.slice(i, i + CHUNK_SIZE);
    const rows: PriceRow[] = chunk.map((v) => ({
      ticker,
      date: v.datetime,
      close_price: parseFloat(v.close),
    }));

    const { error } = await supabase.from("stock_prices").upsert(rows, {
      onConflict: "ticker,date",
    });

    if (error) {
      console.error(`Upsert error for ${ticker} chunk ${i}:`, error);
      result.failed.push({ ticker, error: error.message });
      return;
    }
    totalUpserted += rows.length;
  }

  result.updated.push(ticker);
  result.rows_upserted += totalUpserted;
}
