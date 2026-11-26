import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import type { Client } from "@altananetwork/sdk";
import { CELO_CHAIN_ID, CELO_USDT, TEXTILE_REACTOR, currencyByToken } from "@pocket/core";
import type { AgentSession } from "./altana.js";
import type { FirmQuote, PocketRecord, TxRequest } from "./types.js";

const API = "https://api.textilecredit.com/v2";
type ApiTransaction = { to: string; data: string; value: string; chainId: number };
type RfqApiResponse = {
  reason?: string; error?: { code?: string; reason?: string };
  data?: {
    status?: string; reason?: string; rfqId?: string; claimToken?: string;
    quote?: { taker: string; reactor: string; takerPays: string; buyAmount: string; expiresAt: string };
    transactions?: { approval?: ApiTransaction; swap?: ApiTransaction };
  };
};
const TAKER_TYPES = { TakerControl: [
  { name: "taker", type: "address" }, { name: "chainId", type: "uint256" },
  { name: "nonce", type: "bytes32" }, { name: "issuedAt", type: "uint256" }
] } as const;

function describeUsdtAmount(amount: bigint): string {
  const whole = amount / 1_000_000n, fraction = (amount % 1_000_000n).toString().padStart(6, "0");
  return whole.toString() + "." + fraction + " USDT (" + amount.toString() + " base units)";
}

export class TextileClient {
  constructor(
    private readonly altanaClient: Pick<Client, "signOrderTypedData">,
    private readonly getSession: (pocket: PocketRecord) => Promise<AgentSession>
  ) {}

  async requestFirmQuote(pocket: PocketRecord): Promise<FirmQuote> {
    const currency = currencyByToken(pocket.payoutToken);
    if (!currency || currency.isUsdt) throw new Error("Textile can only quote a verified non-USDT Pocket currency.");
    const amountTried = describeUsdtAmount(pocket.amountUsdt);
    let retriedTakerControl = false;
    while (true) {
      const nonce = ("0x" + randomBytes(32).toString("hex")) as Hex;
      const issuedAt = Date.now();
      const session = await this.getSession(pocket);
      const signature = await this.altanaClient.signOrderTypedData({
        session,
        typedData: {
          domain: { name: "Textile Taker Control", version: "1", chainId: CELO_CHAIN_ID },
          types: TAKER_TYPES,
          primaryType: "TakerControl",
          message: { taker: pocket.agent, chainId: BigInt(CELO_CHAIN_ID), nonce, issuedAt: BigInt(issuedAt) }
        }
      });
      const response = await fetch(API + "/rfq/request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(75_000),
        body: JSON.stringify({
          chainId: CELO_CHAIN_ID, sellToken: CELO_USDT, buyToken: pocket.payoutToken,
          sellAmount: pocket.amountUsdt.toString(), taker: pocket.agent,
          takerProof: { nonce, issuedAt, signature }
        })
      });
      let body: RfqApiResponse;
      try { body = await response.json() as RfqApiResponse; }
      catch (error) {
        throw new Error("Textile RFQ response could not be parsed (HTTP " + response.status + "; amount tried: " +
          amountTried + "): " + (error instanceof Error ? error.message : String(error)));
      }
      const data = body.data;
      const reason = data?.reason ?? body.reason ?? body.error?.code ?? body.error?.reason ?? data?.status ?? "unknown response";
      if (response.status === 502 && reason === "taker_control_unverifiable") {
        if (!retriedTakerControl) { retriedTakerControl = true; continue; }
        throw new Error("Textile returned HTTP 502 taker_control_unverifiable again after one fresh-quote retry; stopped this pocket. Amount tried: " + amountTried + ".");
      }
      if (data?.status === "no_quote") throw new Error("Textile returned no_quote for amount tried: " + amountTried + ". Reason: " + reason + ".");
      if (!response.ok) throw new Error("Textile RFQ failed (HTTP " + response.status + "; amount tried: " + amountTried + "): " + JSON.stringify(body));
      if (!data || data.status !== "quoted" || !data.quote || !data.transactions?.swap) {
        throw new Error("Textile returned no firm quote for amount tried: " + amountTried + ". Reason: " + reason + ".");
      }
      const q = data.quote;
      return {
        rfqId: data.rfqId ?? "", claimToken: data.claimToken ?? "",
        taker: q.taker as Address, reactor: q.reactor as Address,
        takerPays: BigInt(q.takerPays), buyAmount: BigInt(q.buyAmount),
        expiresAt: q.expiresAt, swap: this.toTx(data.transactions.swap)
      };
    }
  }

  async submit(quote: FirmQuote, txHash: Hex): Promise<void> {
    if (!quote.rfqId || !quote.claimToken) throw new Error("RFQ claim details are missing.");
    const response = await fetch(API + "/rfq/" + encodeURIComponent(quote.rfqId) + "/submit", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Rfq-Claim": quote.claimToken },
      body: JSON.stringify({ txHash }), signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error("Textile RFQ submit report failed: HTTP " + response.status);
  }

  private toTx(tx: ApiTransaction): TxRequest {
    if (!tx || !tx.to || !tx.data || tx.value === undefined || tx.chainId !== CELO_CHAIN_ID) {
      throw new Error("Textile returned an incomplete or non-Celo swap transaction request.");
    }
    return { to: tx.to as Address, data: tx.data as Hex, value: tx.value, chainId: tx.chainId };
  }
}
export { TEXTILE_REACTOR };
