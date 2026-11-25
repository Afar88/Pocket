import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@altananetwork/sdk";
import { CELO_USDT, TEXTILE_REACTOR } from "@pocket/core";
import type { AgentSession } from "../src/altana.js";
import { TextileClient } from "../src/textile.js";
import type { PocketRecord } from "../src/types.js";

const agent = "0x1111111111111111111111111111111111111111" as const;
const swapData = "0x12345678abcdef" as const;
const hash = ("0x" + "a".repeat(64)) as const;
const session = {} as AgentSession;
const pocket = {
  agent,
  amountUsdt: 500_000n
} as unknown as PocketRecord;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function quotedResponse() {
  return jsonResponse({
    data: {
      status: "quoted",
      rfqId: "rfq_test",
      claimToken: "claim_test",
      quote: {
        taker: agent,
        reactor: TEXTILE_REACTOR,
        takerPays: "500000",
        buyAmount: "500000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      transactions: {
        // This is deliberately malformed: Pocket must ignore Textile approval.
        approval: { to: CELO_USDT, data: "0x", value: "0", chainId: 1 },
        swap: { to: TEXTILE_REACTOR, data: swapData, value: "0", chainId: 42220 }
      }
    }
  });
}

function createClient() {
  const signer = {
    signOrderTypedData: vi.fn(async () => hash)
  } as unknown as Pick<Client, "signOrderTypedData">;
  const getSession = vi.fn(async () => session);
  return {
    client: new TextileClient(signer, getSession),
    signer,
    getSession
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Textile RFQ client", () => {
  it("ignores Textile's approval transaction and keeps only the Celo swap payload", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => quotedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { client } = createClient();

    const result = await client.requestFirmQuote(pocket);
    expect(result.swap.to).toBe(TEXTILE_REACTOR);
    expect(result).not.toHaveProperty("approval");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs an actionable no_quote error including the amount tried", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      data: { status: "no_quote", reason: "amount too small" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = createClient();

    await expect(client.requestFirmQuote(pocket)).rejects.toThrow(
      /no_quote.*0\.500000 USDT \(500000 base units\).*amount too small/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries taker_control_unverifiable once with a fresh quote proof, then stops clearly", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
        data: { status: "error", reason: "unreachable" }
      }, 502)
    )
      .mockResolvedValueOnce(jsonResponse({
        data: { status: "error", reason: "taker_control_unverifiable" }
      }, 502))
      .mockResolvedValueOnce(jsonResponse({
        data: { status: "error", reason: "taker_control_unverifiable" }
      }, 502));
    vi.stubGlobal("fetch", fetchMock);
    const { client, signer, getSession } = createClient();

    await expect(client.requestFirmQuote(pocket)).rejects.toThrow(
      /HTTP 502 taker_control_unverifiable again after one fresh-quote retry/
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(signer.signOrderTypedData).toHaveBeenCalledTimes(2);

    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    const firstBody = JSON.parse(String(firstInit?.body));
    const secondBody = JSON.parse(String(secondInit?.body));
    expect(firstBody.takerProof.nonce).not.toBe(secondBody.takerProof.nonce);
  });
});
