import {
  CELOSCAN_TX, CELO_USDT, POCKET_REGISTRY_ABI, TEXTILE_REACTOR, currencyByToken
} from "@pocket/core";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import type { AgentLogger, ExecuteResult, FirmQuote, PocketRecord, TxRequest } from "./types.js";

export const SKIP_REASON = {
  rate_below_floor: 1,
  over_cap: 2,
  no_quote: 3,
  session_expired: 4
} as const;

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

function call(tx: TxRequest) { return { to: tx.to, data: tx.data, value: BigInt(tx.value) }; }
function requireConfirmed(result: ExecuteResult, action: string): Hex {
  if (result.status !== "CONFIRMED" || !result.transactionHash) throw new Error(action + " did not confirm (status: " + result.status + ").");
  return result.transactionHash;
}

const transferAbi = [{
  type: "function", name: "transfer", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }]
}] as const;
const approveAbi = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }]
}] as const;
const allowedSwapSelectors = new Set([
  keccak256(toHex("execute((bytes,bytes))")).slice(0, 10).toLowerCase(),
  keccak256(toHex("executeBatch((bytes,bytes)[])")).slice(0, 10).toLowerCase()
]);

function ratePerUsdt(quote: FirmQuote, tokenDecimals: number): bigint {
  // 1e18-scaled human currency units per human USDT; USDT has 6 decimals.
  return quote.buyAmount * (10n ** BigInt(18 + 6 - tokenDecimals)) / quote.takerPays;
}

function skipTx(pocket: PocketRecord, reason: number, registryAddress: Address) {
  return {
    to: registryAddress,
    data: encodeFunctionData({ abi: POCKET_REGISTRY_ABI, functionName: "skipPocket", args: [pocket.id, reason] }),
    value: 0n
  };
}

async function recordSkip(deps: RunnerDeps, pocket: PocketRecord, reason: number, label: string) {
  const now = BigInt(Math.floor(deps.now() / 1000));
  if (pocket.lastSkippedDue === pocket.nextDue) {
    deps.logger.info("Skip already recorded for this due period; leaving it eligible for a later retry.", { pocketId: pocket.id.toString(), reason: label });
    return;
  }
  const tx = requireConfirmed(await deps.execute(pocket, [skipTx(pocket, reason, deps.registryAddress)]), "PocketSkipped " + label);
  deps.logger.info("PocketSkipped " + label + ": " + CELOSCAN_TX + tx, {
    pocketId: pocket.id.toString(), dueAt: pocket.nextDue.toString(), timestamp: now.toString()
  });
}

export async function runDuePockets(deps: RunnerDeps, attributionTag: string): Promise<void> {
  if (!attributionTag.trim()) {
    deps.logger.error("ATTRIBUTION_TAG is empty; refusing to submit any transaction.");
    return;
  }

  let checkedFirstTransaction = false;
  const pockets = await deps.listPockets();
  for (const pocket of pockets) {
    const now = BigInt(Math.floor(deps.now() / 1000));
    if (pocket.deleted || pocket.closed || pocket.paused || pocket.nextDue > now) continue;
    if (pocket.agent === "0x0000000000000000000000000000000000000000") continue;

    try {
      const currency = currencyByToken(pocket.payoutToken);
      if (!currency) throw new Error("Payout token is not in Pocket's verified currency list.");
      if (pocket.usdtDailyCap <= 0n || pocket.usdtDailyCap > deps.maxUsdtDailyCap || pocket.amountUsdt > pocket.usdtDailyCap) {
        await recordSkip(deps, pocket, SKIP_REASON.over_cap, "over_cap");
        continue;
      }
      if (pocket.payoutDailyCap <= 0n) {
        await recordSkip(deps, pocket, SKIP_REASON.over_cap, "over_cap");
        continue;
      }

      if (pocket.sessionExpiry <= now) {
        await recordSkip(deps, pocket, SKIP_REASON.session_expired, "session_expired");
        continue;
      }
      if (!(await deps.isSessionValid(pocket))) {
        deps.logger.error("Pocket " + pocket.id.toString() + " session is revoked or invalid; no payment attempted.");
        continue;
      }

      let payoutAmount = pocket.amountUsdt;
      let usdtSpent = pocket.amountUsdt;
      let quote: FirmQuote | undefined;
      const calls: { to: Address; data: Hex; value: bigint }[] = [];

      if (pocket.payoutToken.toLowerCase() === CELO_USDT.toLowerCase()) {
        // USDT payouts are direct transfers. No Textile request, reactor approval or swap.
        if (payoutAmount > pocket.payoutDailyCap) {
          await recordSkip(deps, pocket, SKIP_REASON.over_cap, "over_cap");
          continue;
        }
      } else {
        try {
          quote = await deps.getQuote(pocket);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/no_quote/i.test(message)) {
            await recordSkip(deps, pocket, SKIP_REASON.no_quote, "no_quote");
            continue;
          }
          throw error;
        }
        if (!quote.rfqId || !quote.claimToken) throw new Error("Textile quote is missing its RFQ ID or claim token.");
        if (quote.taker.toLowerCase() !== pocket.agent.toLowerCase()) throw new Error("Textile quote taker does not match the approved Altana wallet.");
        if (quote.reactor.toLowerCase() !== TEXTILE_REACTOR.toLowerCase()) throw new Error("Textile returned an unrecognised reactor address; refusing to execute.");
        if (quote.swap.to.toLowerCase() !== TEXTILE_REACTOR.toLowerCase()) throw new Error("Textile swap target is not the documented Celo reactor.");
        if (quote.swap.chainId !== 42220) throw new Error("Textile returned a swap transaction for a non-Celo-mainnet chain.");
        const selector = quote.swap.data.length >= 10 ? quote.swap.data.slice(0, 10).toLowerCase() : quote.swap.data.toLowerCase();
        if (!allowedSwapSelectors.has(selector)) throw new Error("Textile swap calldata selector " + (selector || "<missing>") + " is not allowed.");
        if (quote.takerPays <= 0n || quote.takerPays > pocket.amountUsdt || quote.takerPays > deps.maxUsdtDailyCap || quote.takerPays > pocket.usdtDailyCap) {
          await recordSkip(deps, pocket, SKIP_REASON.over_cap, "over_cap");
          continue;
        }
        if (quote.buyAmount <= 0n || quote.buyAmount > pocket.payoutDailyCap) {
          await recordSkip(deps, pocket, SKIP_REASON.over_cap, "over_cap");
          continue;
        }
        const quoteExpiry = Date.parse(quote.expiresAt);
        if (!Number.isFinite(quoteExpiry) || deps.now() >= quoteExpiry) throw new Error("Textile quote is invalid or expired before execution.");

        if (pocket.minOutPerUsdt > 0n && ratePerUsdt(quote, currency.decimals) < pocket.minOutPerUsdt) {
          await recordSkip(deps, pocket, SKIP_REASON.rate_below_floor, "rate_below_floor");
          continue;
        }

        const currentAllowance = await deps.allowance(pocket.agent, TEXTILE_REACTOR);
        if (currentAllowance < quote.takerPays) {
          calls.push({
            to: CELO_USDT,
            data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [TEXTILE_REACTOR, quote.takerPays] }),
            value: 0n
          });
        }
        calls.push(call(quote.swap));
        payoutAmount = quote.buyAmount;
        usdtSpent = quote.takerPays;

        // Check the expiry again after allowance lookup and calldata assembly.
        if (deps.now() >= quoteExpiry) throw new Error("Textile quote expired before the Altana settlement batch; no transaction was sent.");
      }

      const txRef = quote
        ? keccak256(toHex(quote.rfqId))
        : keccak256(toHex("pocket:" + pocket.id.toString() + ":" + pocket.nextDue.toString()));
      calls.push({
        to: pocket.payoutToken,
        data: encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [pocket.recipient, payoutAmount] }),
        value: 0n
      });
      calls.push({
        to: deps.registryAddress,
        data: encodeFunctionData({
          abi: POCKET_REGISTRY_ABI, functionName: "markPaid",
          args: [pocket.id, pocket.payoutToken, usdtSpent, payoutAmount, pocket.nextDue, txRef]
        }),
        value: 0n
      });
      if (calls.length === 0) throw new Error("Refusing to submit an empty Altana session batch.");

      const settlementHash = requireConfirmed(
        await deps.execute(pocket, calls),
        quote ? "Textile swap, payout, and PocketRegistry update" : "USDT transfer and PocketRegistry update"
      );
      deps.logger.info("Pocket payment confirmed: " + CELOSCAN_TX + settlementHash, {
        pocketId: pocket.id.toString(), payoutToken: pocket.payoutToken,
        usdtSpent: usdtSpent.toString(), amountOut: payoutAmount.toString()
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
      if (quote) {
        try { await deps.submitQuote(quote, settlementHash); }
        catch (error) {
          deps.logger.warn("Textile submit report failed; onchain settlement remains the source of truth.", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } catch (error) {
      deps.logger.error("Pocket " + pocket.id.toString() + " processing stopped.", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
