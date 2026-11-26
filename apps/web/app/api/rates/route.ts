import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Textile lists some corridors under wrapped-token names (WARS, WBRL), so
// each payout currency checks every name it trades under.
const TARGET_CURRENCY: Record<string, string[]> = {
  NGN: ["NGN", "CNGN"], ARS: ["WARS", "ARS"], BRL: ["WBRL", "BRL", "BRLA"], MXN: ["WMXN", "MXN"],
  COP: ["WCOP", "COP"], COPM: ["COPM", "COP"],
  IDR: ["IDR", "IDRX"], GBP: ["VGBP", "GBP"], CHF: ["VCHF", "CHF"]
};

type TextileTicker = {
  ticker_id?: string;
  base_currency?: string;
  target_currency?: string;
  bid?: string;
  last_price?: string;
};

export async function GET(request: Request) {
  const currency = (new URL(request.url).searchParams.get("currency") || "").toUpperCase();
  const targets = TARGET_CURRENCY[currency];
  if (!targets) return NextResponse.json({ error: "Unsupported Textile payout currency." }, { status: 400 });

  let tickers: TextileTicker[] | null = null;
  for (let attempt = 0; attempt < 2 && !tickers; attempt++) {
    try {
      const response = await fetch("https://api.textilecredit.com/tickers?base=USDT", {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) continue;
      const payload = await response.json() as TextileTicker[] | { data?: TextileTicker[] };
      tickers = Array.isArray(payload) ? payload : payload.data ?? [];
    } catch { /* try once more */ }
  }
  if (!tickers) return NextResponse.json({ error: "Textile rate feed is temporarily unavailable." }, { status: 502 });

  const matches = tickers.filter((item) =>
    item.base_currency?.toUpperCase() === "USDT" && targets.includes((item.target_currency || "").toUpperCase()));
  // Prefer a live bid; when no maker is bidding, fall back to the last trade.
  const withBid = matches.find((item) => Number(item.bid || "0") > 0);
  const withLast = matches.find((item) => Number(item.last_price || "0") > 0);
  const ticker = withBid ?? withLast;
  if (!ticker) return NextResponse.json({ error: "No Textile rate is available for this corridor." }, { status: 404 });
  const source = withBid ? "bid" : "last";
  return NextResponse.json({
    tickerId: ticker.ticker_id || ("USDT_" + ticker.target_currency),
    bid: (withBid ? ticker.bid : ticker.last_price) as string,
    source,
    asOf: new Date().toISOString()
  }, { headers: { "Cache-Control": "no-store" } });
}
