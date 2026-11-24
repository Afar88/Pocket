import { randomBytes } from "node:crypto";
import type { Address, Hex, WalletClient } from "viem";
import { CELO_CHAIN_ID, CELO_USDT, CNGN, TEXTILE_REACTOR } from "@pocket/core";
import type { FirmQuote, PocketRecord, TxRequest } from "./types.js";

const API = "https://api.textilecredit.com/v2";

type ApiTransaction = { to: string; data: string; value: string; chainId: number };
type RfqApiResponse = {
  data?: {
    status?: string;
    reason?: string;
    rfqId?: string;
    claimToken?: string;
    quote?: {
      taker: string;
      reactor: string;
      takerPays: string;
      buyAmount: string;
      expiresAt: string;
    };
    transactions?: {
      approval: ApiTransaction;
      swap: ApiTransaction;
    };
  };
};

const TAKER_TYPES = {
  TakerControl: [
    { name: "taker", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint256" }
  ]
} as const;

export class TextileClient {
  constructor(
    private readonly walletClient: WalletClient,
    private readonly signerAddress: Address
  ) {}

  async requestFirmQuote(pocket: PocketRecord): Promise<FirmQuote> {
    const nonce = ("0x" + randomBytes(32).toString("hex")) as Hex;
    const issuedAt = Date.now();

    // The session key signs the proof. Textile documents EIP-712 TakerControl
    // for keyless callers; acceptance of an Altana session key as an EIP-1271
    // proof for the smart-account taker must be confirmed before live use.
    const signature = await this.walletClient.signTypedData({
      account: this.signerAddress,
      domain: { name: "Textile Taker Control", version: "1", chainId: CELO_CHAIN_ID },
      types: TAKER_TYPES,
      primaryType: "TakerControl",
      message: {
        taker: pocket.agent,
        chainId: BigInt(CELO_CHAIN_ID),
        nonce,
        issuedAt: BigInt(issuedAt)
      }
    });

    const response = await fetch(API + "/rfq/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(75_000),
      body: JSON.stringify({
        chainId: CELO_CHAIN_ID,
        sellToken: CELO_USDT,
        buyToken: CNGN,
        sellAmount: pocket.amountUsdt.toString(),
        taker: pocket.agent,
        takerProof: { nonce, issuedAt, signature }
      })
    });

    const body = await response.json() as RfqApiResponse;
    if (!response.ok) {
      throw new Error("Textile RFQ failed (" + response.status + "): " + JSON.stringify(body));
    }
    const data = body.data;
    if (!data || data.status !== "quoted" || !data.quote || !data.transactions) {
      throw new Error("Textile returned no firm quote: " + (data?.reason ?? data?.status ?? "unknown response"));
    }

    const q = data.quote;
    const tx = data.transactions;
    return {
      rfqId: data.rfqId ?? "",
      claimToken: data.claimToken ?? "",
      taker: q.taker as Address,
      reactor: q.reactor as Address,
      takerPays: BigInt(q.takerPays),
      buyAmount: BigInt(q.buyAmount),
      expiresAt: q.expiresAt,
      approval: this.toTx(tx.approval),
      swap: this.toTx(tx.swap)
    };
  }

  async submit(quote: FirmQuote, txHash: Hex): Promise<void> {
    if (!quote.rfqId || !quote.claimToken) throw new Error("RFQ claim details are missing.");
    const response = await fetch(API + "/rfq/" + encodeURIComponent(quote.rfqId) + "/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rfq-Claim": quote.claimToken
      },
      body: JSON.stringify({ txHash }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      throw new Error("Textile RFQ submit report failed: HTTP " + response.status);
    }
  }

  private toTx(tx: ApiTransaction): TxRequest {
    if (!tx || !tx.to || !tx.data || tx.value === undefined || tx.chainId !== CELO_CHAIN_ID) {
      throw new Error("Textile returned an incomplete or non-Celo transaction request.");
    }
    return {
      to: tx.to as Address,
      data: tx.data as Hex,
      value: tx.value,
      chainId: tx.chainId
    };
  }
}

export { TEXTILE_REACTOR };
