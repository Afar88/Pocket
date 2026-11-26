import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@altananetwork/sdk";
import { CELO_USDT, TEXTILE_REACTOR, POCKET_CURRENCIES } from "@pocket/core";
import type { AgentSession } from "../src/altana.js";
import { TextileClient } from "../src/textile.js";
import type { PocketRecord } from "../src/types.js";

const agent = "0x1111111111111111111111111111111111111111" as const;
const wBRL = POCKET_CURRENCIES.find((currency) => currency.symbol === "wBRL")!;
const swapData = "0x12345678abcdef" as const;
const hash = ("0x" + "a".repeat(64)) as const;
const session = {} as AgentSession;
const pocket = { agent, amountUsdt: 500_000n, payoutToken: wBRL.address } as unknown as PocketRecord;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function quotedResponse() {
  return jsonResponse({ data: {
    status: "quoted", rfqId: "rfq_test", claimToken: "claim_test",
    quote: { taker: agent, reactor: TEXTILE_REACTOR, takerPays: "500000", buyAmount: "500000000", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    transactions: {
      approval: { to: CELO_USDT, data: "0x", value: "0", chainId: 1 },
      swap: { to: TEXTILE_REACTOR, data: swapData, value: "0", chainId: 42220 }
    }
  }});
}
function createClient() {
  const signer = { signOrderTypedData: vi.fn(async () => hash) } as unknown as Pick<Client, "signOrderTypedData">;
  const getSession = vi.fn(async () => session);
  return { client: new TextileClient(signer, getSession), signer, getSession };
}
afterEach(() => vi.unstubAllGlobals());

describe("Textile RFQ client", () => {
  it("requests USDT to wBRL and ignores Textile's approval transaction", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => quotedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { client } = createClient();
    const result = await client.requestFirmQuote(pocket);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const request = JSON.parse(String(init?.body));
    expect(request.sellToken).toBe(CELO_USDT);
    expect(request.buyToken).toBe(wBRL.address);
    expect(result.swap.to).toBe(TEXTILE_REACTOR);
    expect(result).not.toHaveProperty("approval");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs an actionable no_quote error including the amount tried", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { status: "no_quote", reason: "amount too small" } })));
    const { client } = createClient();
    await expect(client.requestFirmQuote(pocket)).rejects.toThrow(/no_quote.*0\.500000 USDT \(500000 base units\).*amount too small/);
  });

  it("retries taker_control_unverifiable once with a fresh quote proof, then stops", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { status: "error", reason: "taker_control_unverifiable" } }, 502));
    vi.stubGlobal("fetch", fetchMock);
    const { client, signer, getSession } = createClient();
    await expect(client.requestFirmQuote(pocket)).rejects.toThrow(/HTTP 502 taker_control_unverifiable again after one fresh-quote retry/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(signer.signOrderTypedData).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const second = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(first.takerProof.nonce).not.toBe(second.takerProof.nonce);
  });
});
