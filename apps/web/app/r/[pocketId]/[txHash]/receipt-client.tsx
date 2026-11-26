"use client";

import { useEffect, useState } from "react";
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  isHex,
  type Address,
  type Hex
} from "viem";
import { celo } from "viem/chains";
import {
  CELO_CHAIN_ID,
  CELO_RPC_DEFAULT,
  CELOSCAN_TX,
  POCKET_CURRENCIES,
  POCKET_PAID_EVENT,
  POCKET_REGISTRY_ABI
} from "@pocket/core";

const TRANSFER_EVENT_ABI = [{
  type: "event", name: "Transfer", anonymous: false,
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false }
  ]
}] as const;

type ReceiptState = {
  amount: string;
  currency: string;
  note: string;
  recipient: Address;
  timestamp: bigint;
  txHash: Hex;
} | null;

export default function PocketReceipt({ pocketId, txHash }: { pocketId: string; txHash: string }) {
  const [receipt, setReceipt] = useState<ReceiptState>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function verify() {
      setLoading(true);
      setError("");
      try {
        if (!/^\d+$/.test(pocketId) || (!isHex(txHash) || txHash.length !== 66)) {
          throw new Error("This receipt link is not valid.");
        }
        const configResponse = await fetch("/api/config", { cache: "no-store" });
        if (!configResponse.ok) throw new Error("Pocket configuration is unavailable.");
        const config = await configResponse.json() as { chainId: number; rpcUrl?: string; registryAddress?: string };
        if (config.chainId !== CELO_CHAIN_ID || !config.registryAddress) throw new Error("PocketRegistry is not configured for Celo mainnet.");

        const client = createPublicClient({
          chain: celo,
          transport: http(config.rpcUrl || CELO_RPC_DEFAULT)
        });
        const hash = txHash as Hex;
        // Re-read the canonical receipt on every page load. No local receipt cache is trusted.
        const txReceipt = await client.getTransactionReceipt({ hash });
        if (txReceipt.status !== "success") throw new Error("The Celo transaction did not succeed.");

        let paid: { payoutToken: Address; usdtSpent: bigint; amountOut: bigint; timestamp: bigint } | null = null;
        for (const log of txReceipt.logs) {
          if (log.address.toLowerCase() !== config.registryAddress.toLowerCase()) continue;
          try {
            const decoded = decodeEventLog({ abi: [POCKET_PAID_EVENT], data: log.data, topics: log.topics });
            if (decoded.eventName === "PocketPaid" && decoded.args.pocketId === BigInt(pocketId)) {
              paid = {
                payoutToken: decoded.args.payoutToken,
                usdtSpent: decoded.args.usdtSpent,
                amountOut: decoded.args.amountOut,
                timestamp: decoded.args.timestamp
              };
            }
          } catch { /* Ignore logs that are not PocketPaid. */ }
        }
        if (!paid) throw new Error("This transaction does not contain a confirmed payment for this pocket.");

        const currency = POCKET_CURRENCIES.find((item) => item.address.toLowerCase() === paid!.payoutToken.toLowerCase());
        if (!currency) throw new Error("The payout token is not in Pocket's verified currency list.");
        const pocket = await client.readContract({
          address: config.registryAddress as Address,
          abi: POCKET_REGISTRY_ABI,
          functionName: "getPocket",
          args: [BigInt(pocketId)],
          blockNumber: txReceipt.blockNumber
        });
        const transferVerified = txReceipt.logs.some((log) => {
          if (log.address.toLowerCase() !== paid!.payoutToken.toLowerCase()) return false;
          try {
            const transfer = decodeEventLog({ abi: TRANSFER_EVENT_ABI, data: log.data, topics: log.topics });
            return transfer.args.from.toLowerCase() === pocket.owner.toLowerCase() &&
              transfer.args.to.toLowerCase() === pocket.recipient.toLowerCase() &&
              transfer.args.value === paid!.amountOut;
          } catch { return false; }
        });
        if (!transferVerified) throw new Error("This receipt has no matching payout-token transfer from the pocket owner to the receiver.");

        const result: ReceiptState = {
          amount: formatUnits(paid.amountOut, currency.decimals),
          currency: currency.symbol,
          note: pocket.note,
          recipient: pocket.recipient,
          timestamp: paid.timestamp,
          txHash: hash
        };
        if (!cancelled) setReceipt(result);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void verify();
    return () => { cancelled = true; };
  }, [pocketId, txHash]);

  function shareWhatsApp() {
    const text = receipt
      ? "Pocket payment receipt: " + receipt.amount + " " + receipt.currency + " · " + receipt.note + " · " + window.location.href
      : window.location.href;
    window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener,noreferrer");
  }

  return (
    <main>
      <header>
        <div className="brand"><div className="mark">P</div><div><h1>Pocket</h1><p className="sub">Verified payment receipt · Celo mainnet</p></div></div>
        <span className="pill">Chain 42220</span>
      </header>
      <section className="panel">
        <h2>Payment receipt</h2>
        {loading ? <p className="small">Re-checking this transaction on Celo…</p> : error ? <p className="error">{error}</p> : receipt ? (
          <div className="payment-receipt">
            <div className="pocket-amount"><span>Receiver got</span><strong>{receipt.amount} {receipt.currency}</strong></div>
            <div className="pocket-facts">
              <div><span>Pocket</span><strong>#{pocketId}</strong></div>
              <div><span>Recipient</span><code>{receipt.recipient}</code></div>
              <div><span>Public note</span><strong>{receipt.note || "—"}</strong></div>
              <div><span>Confirmed at</span><strong>{new Date(Number(receipt.timestamp) * 1000).toLocaleString()}</strong></div>
              <div><span>Transaction</span><code>{receipt.txHash}</code></div>
            </div>
            <div className="actions">
              <a className="receipt-link" href={CELOSCAN_TX + receipt.txHash} target="_blank" rel="noreferrer">View on Celoscan ↗</a>
              <button onClick={shareWhatsApp}>Share on WhatsApp</button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
