import {
  CELOSCAN_TX,
  CELO_USDT,
  CNGN,
  POCKET_REGISTRY_ABI,
  TEXTILE_REACTOR
} from "@pocket/core";
import {
  encodeFunctionData,
  keccak256,
  toHex,
  type Address,
  type Hex
} from "viem";
import type {
  AgentLogger,
  ExecuteResult,
  FirmQuote,
  PocketRecord,
  TxRequest
} from "./types.js";

export type RunnerDeps = {
  now: () => number;
  registryAddress: Address;
  maxUsdtDailyCap: bigint;
  listPockets: () => Promise<PocketRecord[]>;
  isSessionValid: (pocket: PocketRecord) => Promise<boolean>;
  getQuote: (pocket: PocketRecord) => Promise<FirmQuote>;
  allowance: (wallet: Address, spender: Address) => Promise<bigint>;
  execute: (pocket: PocketRecord, calls: readonly { to: Address; data: Hex; value: bigint }[]) => Promise<ExecuteResult>;
  verifyAttribution: (hash: Hex) => Promise<boolean | null>;
  submitQuote: (quote: FirmQuote, hash: Hex) => Promise<void>;
  logger: AgentLogger;
};

function call(tx: TxRequest) {
  return { to: tx.to, data: tx.data, value: BigInt(tx.value) };
}

function requireConfirmed(result: ExecuteResult, action: string): Hex {
  if (result.status !== "CONFIRMED" || !result.transactionHash) {
    throw new Error(action + " did not confirm (status: " + result.status + ").");
  }
  return result.transactionHash;
}

const approveAbi = [{
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" }
  ],
  outputs: [{ name: "", type: "bool" }]
}] as const;

const transferAbi = [{
  type: "function",
  name: "transfer",
  stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }]
}] as const;

const allowedSwapSelectors = new Set([
  keccak256(toHex("execute((bytes,bytes))")).slice(0, 10).toLowerCase(),
  keccak256(toHex("executeBatch((bytes,bytes)[])")).slice(0, 10).toLowerCase()
]);

export async function runDuePockets(deps: RunnerDeps, attributionTag: string): Promise<void> {
  if (!attributionTag.trim()) {
    deps.logger.error("ATTRIBUTION_TAG is empty; refusing to submit any transaction.");
    return;
  }

  let checkedFirstTransaction = false;
  const pockets = await deps.listPockets();
  for (const pocket of pockets) {
    if (pocket.deleted || pocket.paused || pocket.nextDue > BigInt(Math.floor(deps.now() / 1000))) continue;
    if (pocket.agent === "0x0000000000000000000000000000000000000000") continue;

    try {
      if (pocket.usdtDailyCap <= 0n || pocket.usdtDailyCap > deps.maxUsdtDailyCap) {
        throw new Error("Recorded USDt daily session cap is above the 5 USDt safety ceiling.");
      }
      if (pocket.amountUsdt > pocket.usdtDailyCap) {
        throw new Error("Pocket amount exceeds its recorded daily USDt session cap.");
      }
      if (pocket.sessionExpiry <= BigInt(Math.floor(deps.now() / 1000))) {
        throw new Error("Recorded Altana session has expired.");
      }
      if (!(await deps.isSessionValid(pocket))) {
        throw new Error("Altana Keystore reports the session key as revoked or invalid.");
      }

      const quote = await deps.getQuote(pocket);
      if (!quote.rfqId || !quote.claimToken) {
        throw new Error("Textile quote is missing its RFQ ID or claim token.");
      }
      if (quote.taker.toLowerCase() !== pocket.agent.toLowerCase()) {
        throw new Error("Textile quote taker does not match the approved Altana wallet.");
      }
      if (quote.reactor.toLowerCase() !== TEXTILE_REACTOR.toLowerCase()) {
        throw new Error("Textile returned an unrecognised reactor address; refusing to execute.");
      }
      if (quote.swap.to.toLowerCase() !== TEXTILE_REACTOR.toLowerCase()) {
        throw new Error("Textile swap target is not the documented Celo reactor.");
      }
      if (quote.swap.chainId !== 42220) {
        throw new Error("Textile returned a swap transaction for a non-Celo-mainnet chain.");
      }

      const selector = quote.swap.data.length >= 10
        ? quote.swap.data.slice(0, 10).toLowerCase()
        : quote.swap.data.toLowerCase();
      if (!allowedSwapSelectors.has(selector)) {
        throw new Error(
          "Textile swap calldata selector " + (selector || "<missing>") +
          " is not allowed; expected execute((bytes,bytes)) or executeBatch((bytes,bytes)[])."
        );
      }

      if (quote.takerPays <= 0n || quote.takerPays > pocket.amountUsdt || quote.takerPays > deps.maxUsdtDailyCap) {
        throw new Error("Textile quote exceeds the pocket's maximum USDt amount or the 5 USDt safety ceiling.");
      }
      if (quote.buyAmount <= 0n || quote.buyAmount > pocket.cngnDailyCap) {
        throw new Error("Textile cNGN output exceeds the recorded daily session cap.");
      }

      const quoteExpiry = Date.parse(quote.expiresAt);
      if (!Number.isFinite(quoteExpiry) || deps.now() >= quoteExpiry) {
        throw new Error("Textile quote is invalid or expired before execution.");
      }

      const currentAllowance = await deps.allowance(pocket.agent, TEXTILE_REACTOR);
      const batchCalls: { to: Address; data: Hex; value: bigint }[] = [];

      // Textile's approval payload is intentionally ignored. If needed, Pocket
      // builds an exact allowance for this quote and includes it in settlement.
      if (currentAllowance < quote.takerPays) {
        batchCalls.push({
          to: CELO_USDT,
          data: encodeFunctionData({
            abi: approveAbi,
            functionName: "approve",
            args: [TEXTILE_REACTOR, quote.takerPays]
          }),
          value: 0n
        });
      }

      const txRef = keccak256(toHex(quote.rfqId));
      const payoutData = encodeFunctionData({
        abi: transferAbi,
        functionName: "transfer",
        args: [pocket.recipient, quote.buyAmount]
      });
      const recordSwapData = encodeFunctionData({
        abi: POCKET_REGISTRY_ABI,
        functionName: "recordSwap",
        args: [pocket.id, txRef]
      });
      const markPaidData = encodeFunctionData({
        abi: POCKET_REGISTRY_ABI,
        functionName: "markPaid",
        args: [pocket.id, txRef]
      });

      batchCalls.push(
        call(quote.swap),
        { to: CNGN, data: payoutData, value: 0n },
        { to: deps.registryAddress, data: recordSwapData, value: 0n },
        { to: deps.registryAddress, data: markPaidData, value: 0n }
      );

      // Re-check expiry after the allowance read and call encoding. Every action
      // for this settlement (including a needed approval) is one Altana batch.
      if (deps.now() >= quoteExpiry) {
        throw new Error("Textile quote expired before the Altana settlement batch; no transaction was sent.");
      }

      const settlementHash = requireConfirmed(
        await deps.execute(pocket, batchCalls),
        "Textile swap, cNGN payout, and PocketRegistry update"
      );

      deps.logger.info("Textile swap confirmed: " + CELOSCAN_TX + settlementHash, {
        pocketId: pocket.id.toString(),
        buyAmount: quote.buyAmount.toString(),
        approvalIncluded: currentAllowance < quote.takerPays
      });
      deps.logger.info("cNGN payment confirmed: " + CELOSCAN_TX + settlementHash, {
        pocketId: pocket.id.toString(),
        recipient: pocket.recipient
      });
      if (!checkedFirstTransaction) {
        try {
          const present = await deps.verifyAttribution(settlementHash);
          deps.logger.info("First transaction attribution check", { present });
        } catch (error) {
          deps.logger.warn("Attribution verification request failed after confirmed payment.", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
        checkedFirstTransaction = true;
      }

      try {
        await deps.submitQuote(quote, settlementHash);
      } catch (error) {
        deps.logger.warn("Textile submit report failed; onchain settlement remains the source of truth.", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } catch (error) {
      deps.logger.error("Pocket " + pocket.id.toString() + " processing stopped.", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
