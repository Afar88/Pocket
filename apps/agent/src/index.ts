import {
  createPublicClient,
  http,
  parseUnits,
  type Address,
  type Hex
} from "viem";
import { celo } from "viem/chains";
import { verifyTx } from "@celo/attribution-tags";
import { parseAttribution } from "@altananetwork/sdk";
import {
  CELOSCAN_TX,
  CELO_USDT,
  CELO_RPC_DEFAULT,
  ERC20_ABI,
  MAX_USDT_DAILY_CAP,
  POCKET_AGENT_ID,
  POCKET_REGISTRY_ABI
} from "@pocket/core";
import { readAgentConfig, assertAttributionTag } from "./config.js";
import { createAltana, createPocketSession, executeSessionCalls } from "./altana.js";
import { TextileClient } from "./textile.js";
import { runDuePockets } from "./runner.js";
import type { PocketRecord } from "./types.js";
import { consoleLogger } from "./types.js";

const POLL_MS = 120_000;

async function main() {
  const tag = process.env.ATTRIBUTION_TAG ?? "";
  if (!tag) {
    consoleLogger.error("ATTRIBUTION_TAG is empty. Pocket will not submit any transaction.");
    if (process.env.POCKET_RUN_ONCE === "1" || process.argv.includes("--once")) {
      process.exitCode = 1;
      return;
    }
    setInterval(() => consoleLogger.error("Still blocked: set ATTRIBUTION_TAG before enabling payments."), POLL_MS);
    return;
  }
  assertAttributionTag(tag);

  const config = readAgentConfig();
  const publicClient = createPublicClient({
    chain: celo,
    transport: http(config.rpcUrl || CELO_RPC_DEFAULT)
  });

  const chainId = await publicClient.getChainId();
  if (chainId !== 42220) {
    throw new Error("Pocket agent requires Celo mainnet (42220); RPC returned chain " + chainId + ".");
  }

  // Value-moving calls and Textile's wallet-bound TakerControl signature use
  // Altana's session client only; Altana appCode tags every relayed session
  // transaction. This process holds no EOA signing key.

  const { client: altanaClient } = createAltana(config);
  const tokenDecimals = await publicClient.readContract({
    address: CELO_USDT,
    abi: ERC20_ABI,
    functionName: "decimals"
  });
  const maxUsdtDailyCap = parseUnits(MAX_USDT_DAILY_CAP, Number(tokenDecimals));

  const listPockets = async (): Promise<PocketRecord[]> => {
    const count = await publicClient.readContract({
      address: config.registryAddress,
      abi: POCKET_REGISTRY_ABI,
      functionName: "pocketCount"
    });
    const result: PocketRecord[] = [];
    for (let id = 1n; id <= count; id += 1n) {
      const p = await publicClient.readContract({
        address: config.registryAddress,
        abi: POCKET_REGISTRY_ABI,
        functionName: "getPocket",
        args: [id]
      });
      result.push({
        id,
        owner: p.owner,
        recipient: p.recipient,
        amountUsdt: p.amountUsdt,
        payoutToken: p.payoutToken,
        period: p.period,
        nextDue: p.nextDue,
        label: p.label,
        note: p.note,
        paused: p.paused,
        closed: p.closed,
        deleted: p.deleted,
        agent: p.agent,
        sessionKeyId: p.sessionKeyId,
        sessionExpiry: p.sessionExpiry,
        usdtDailyCap: p.usdtDailyCap,
        payoutDailyCap: p.payoutDailyCap,
        minOutPerUsdt: p.minOutPerUsdt,
        lastSkippedDue: p.lastSkippedDue,
        lastSkippedReason: p.lastSkippedReason,
        encryptedSessionKey: p.encryptedSessionKey,
        serializedSession: p.serializedSession
      });
    }
    return result;
  };

  // Rebuild and re-check the Keystore on every use. A revoked key must
  // be noticed on the next poll, not hidden behind a cached Session object.
  const getSession = async (pocket: PocketRecord) =>
    createPocketSession(config, publicClient, pocket);

  const textile = new TextileClient(altanaClient, getSession);

  const runnerDeps = {
    now: () => Date.now(),
    registryAddress: config.registryAddress,
    maxUsdtDailyCap,
    listPockets,
    isSessionValid: async (pocket: PocketRecord) => {
      try {
        await getSession(pocket);
        return true;
      } catch (error) {
        consoleLogger.warn("Pocket session check failed.", {
          error: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    },
    getQuote: (pocket: PocketRecord) => textile.requestFirmQuote(pocket),
    allowance: (wallet: Address, spender: Address) => publicClient.readContract({
      address: CELO_USDT,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [wallet, spender]
    }),
    execute: async (pocket: PocketRecord, calls: readonly { to: Address; data: Hex; value: bigint }[]) => {
      const session = await getSession(pocket);
      return executeSessionCalls(altanaClient, session, calls);
    },
    verifyAttribution: async (hash: Hex) => {
      // @celo/attribution-tags currently carries its own viem type copy.
      // The clients share the same runtime transport; bridge the duplicate TS type here.
      const result = await verifyTx({
        client: publicClient as unknown as Parameters<typeof verifyTx>[0]["client"],
        hash
      });
      // SDK 0.7.0 verifies the executed Altana intent and returns its authorising
      // wallet as sender. Keep Altana's input parser as a compatibility fallback.
      let codes = result?.codes ?? [];
      if (!codes.includes(config.attributionTag)) {
        const tx = await publicClient.getTransaction({ hash });
        codes = parseAttribution(tx.input)?.codes ?? [];
      }
      const present = codes.includes(config.attributionTag);
      consoleLogger.info("verifyTx: first live transaction attribution result", {
        transaction: CELOSCAN_TX + hash,
        expectedTag: config.attributionTag,
        returnedCodes: codes,
        tagPresent: present,
        result
      });
      return present;
    },
    submitQuote: (quote: Parameters<typeof textile.submit>[0], hash: Hex) => textile.submit(quote, hash),
    logger: consoleLogger
  };

  const run = async () => {
    try {
      await runDuePockets(runnerDeps, config.attributionTag);
    } catch (error) {
      consoleLogger.error("Agent poll failed.", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const runOnce = process.env.POCKET_RUN_ONCE === "1" || process.argv.includes("--once");
  consoleLogger.info("Pocket agent started on Celo mainnet.", {
    chainId: 42220,
    registry: config.registryAddress,
    pollMs: runOnce ? 0 : POLL_MS,
    runOnce,
    workerIdentity: config.agentAddress,
    erc8004AgentId: POCKET_AGENT_ID.toString(),
    maxUsdtDailyCap: maxUsdtDailyCap.toString()
  });
  await run();
  if (!runOnce) setInterval(() => void run(), POLL_MS);
}

main().catch((error) => {
  console.error("Pocket agent stopped:", error);
  process.exitCode = 1;
});
