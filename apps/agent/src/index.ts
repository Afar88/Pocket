import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
  type Hex,
  type WalletClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { withAttribution, verifyTx } from "@celo/attribution-tags";
import {
  CELOSCAN_TX,
  CELO_USDT,
  CELO_RPC_DEFAULT,
  ERC20_ABI,
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
  const tag = (process.env.ATTRIBUTION_TAG ?? "").trim();
  if (!tag) {
    consoleLogger.error("ATTRIBUTION_TAG is empty. Pocket will not submit any transaction.");
    setInterval(() => consoleLogger.error("Still blocked: set ATTRIBUTION_TAG before enabling payments."), POLL_MS);
    return;
  }
  assertAttributionTag(tag);

  const config = readAgentConfig();
  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({
    chain: celo,
    transport: http(config.rpcUrl || CELO_RPC_DEFAULT)
  });

  const chainId = await publicClient.getChainId();
  if (chainId !== 42220) {
    throw new Error("Pocket agent requires Celo mainnet (42220); RPC returned chain " + chainId + ".");
  }

  // One viem wallet client, tagged once. It signs the Textile TakerControl
  // proof. Value-moving calls use Altana client.execute({session,calls}) so they
  // remain inside the user's session policy; Altana adds the same appCode tag.
  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http(config.rpcUrl)
  }).extend(withAttribution(config.attributionTag));

  const { client: altanaClient } = createAltana(config);
  const textile = new TextileClient(walletClient as unknown as WalletClient, account.address);

  const tokenDecimals = await publicClient.readContract({
    address: CELO_USDT,
    abi: ERC20_ABI,
    functionName: "decimals"
  });
  const maxUsdtDailyCap = parseUnits("5", Number(tokenDecimals));

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
        period: p.period,
        nextDue: p.nextDue,
        label: p.label,
        paused: p.paused,
        deleted: p.deleted,
        agent: p.agent,
        sessionKeyId: p.sessionKeyId,
        sessionExpiry: p.sessionExpiry,
        usdtDailyCap: p.usdtDailyCap,
        cngnDailyCap: p.cngnDailyCap
      });
    }
    return result;
  };

  const sessions = new Map<string, Awaited<ReturnType<typeof createPocketSession>>>();
  const getSession = async (pocket: PocketRecord) => {
    const key = pocket.sessionKeyId.toLowerCase();
    const cached = sessions.get(key);
    if (cached && cached.expiry > Math.floor(Date.now() / 1000)) return cached;
    const session = await createPocketSession(config, publicClient, pocket);
    sessions.set(key, session);
    return session;
  };

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
      const result = await verifyTx({ client: publicClient, hash });
      const present = Boolean(result?.codes.includes(config.attributionTag));
      consoleLogger.info("ERC-8021 verification: " + CELOSCAN_TX + hash, {
        expected: config.attributionTag,
        result,
        present
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

  consoleLogger.info("Pocket agent started on Celo mainnet.", {
    chainId: 42220,
    registry: config.registryAddress,
    pollMs: POLL_MS,
    sessionSigner: account.address,
    maxUsdtDailyCap: maxUsdtDailyCap.toString()
  });
  await run();
  setInterval(() => void run(), POLL_MS);
}

main().catch((error) => {
  console.error("Pocket agent stopped:", error);
  process.exitCode = 1;
});
