import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TARGET_CURRENCY: Record<string, string[]> = {
  NGN: ["NGN"], ARS: ["ARS"], BRL: ["BRL"], MXN: ["MXN"],
  COP: ["COP", "COPM"], COPM: ["COPM", "COP"],
  IDR: ["IDR"], GBP: ["GBP"], CHF: ["CHF"]
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

  try {
    const response = await fetch("https://api.textilecredit.com/tickers?base=USDT", {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return NextResponse.json({ error: "Textile rate feed is temporarily unavailable." }, { status: 502 });
    const payload = await response.json() as TextileTicker[] | { data?: TextileTicker[] };
    const tickers = Array.isArray(payload) ? payload : payload.data ?? [];
    const ticker = tickers.find((item) =>
      item.base_currency?.toUpperCase() === "USDT" &&
      targets.includes((item.target_currency || "").toUpperCase()) &&
      Number(item.bid || "0") > 0
    );
    if (!ticker?.bid) return NextResponse.json({ error: "No live Textile bid is available for this corridor." }, { status: 404 });
    return NextResponse.json({
      tickerId: ticker.ticker_id || ("USDT_" + ticker.target_currency),
      bid: ticker.bid,
      asOf: new Date().toISOString()
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Textile rate feed is temporarily unavailable." }, { status: 502 });
  }
}
