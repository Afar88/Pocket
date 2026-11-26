import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { withAttribution, verifyTx } from "@celo/attribution-tags";
import { CELO_RPC_DEFAULT, ERC8004_IDENTITY_REGISTRY } from "@pocket/core";
import { readSignerConfig, assertAttributionTag } from "./config.js";

const registerAbi = [{
  type: "function",
  name: "register",
  stateMutability: "nonpayable",
  inputs: [{ name: "agentURI", type: "string" }],
  outputs: [{ name: "agentId", type: "uint256" }]
}] as const;

const balanceOfAbi = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }],
  outputs: [{ name: "", type: "uint256" }]
}] as const;

const registeredEventAbi = [{
  type: "event",
  name: "Registered",
  inputs: [
    { name: "agentId", type: "uint256", indexed: true },
    { name: "agentURI", type: "string", indexed: false },
    { name: "owner", type: "address", indexed: true }
  ]
}] as const;

async function registerIdentity() {
  const config = readSignerConfig();
  assertAttributionTag(config.attributionTag);
  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({
    chain: celo,
    transport: http(config.rpcUrl || CELO_RPC_DEFAULT)
  });
  const chainId = await publicClient.getChainId();
  if (chainId !== 42220) {
    throw new Error("ERC-8004 registration requires Celo mainnet (42220).");
  }

  const alreadyRegistered = await publicClient.readContract({
    address: ERC8004_IDENTITY_REGISTRY,
    abi: balanceOfAbi,
    functionName: "balanceOf",
    args: [account.address]
  });
  if (alreadyRegistered > 0n) {
    throw new Error("Agent wallet " + account.address + " is already registered (owns " + alreadyRegistered + " identit" + (alreadyRegistered === 1n ? "y" : "ies") + "). Refusing to register twice.");
  }

  const gasBalance = await publicClient.getBalance({ address: account.address });
  if (gasBalance === 0n) {
    throw new Error("Agent wallet " + account.address + " has no CELO for gas. Send a small amount of CELO to it, then run the workflow again.");
  }

  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http(config.rpcUrl || CELO_RPC_DEFAULT)
  }).extend(withAttribution(config.attributionTag));

  const registration = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Pocket Agent",
    description: "recurring and one-off USDT payouts in the receiver's local stablecoin"
  };
  const encoded = Buffer.from(JSON.stringify(registration)).toString("base64");
  const agentURI = "data:application/json;base64," + encoded;

  console.info("Submitting ERC-8004 registration to", ERC8004_IDENTITY_REGISTRY);
  const hash = await walletClient.writeContract({
    address: ERC8004_IDENTITY_REGISTRY,
    abi: registerAbi,
    functionName: "register",
    args: [agentURI]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error("Registration transaction failed: https://celoscan.io/tx/" + hash);
  }
  const registeredLog = receipt.logs
    .filter((log) => log.address.toLowerCase() === ERC8004_IDENTITY_REGISTRY.toLowerCase())
    .map((log) => {
      try {
        return decodeEventLog({ abi: registeredEventAbi, data: log.data, topics: log.topics });
      } catch {
        return null;
      }
    })
    .find((event) => event !== null);
  const confirmedHash = receipt.transactionHash;
  const attribution = await verifyTx({ client: publicClient, hash: confirmedHash });
  const tagPresent = Boolean(attribution?.codes.includes(config.attributionTag));
  console.info("ERC-8004 registration transaction:", "https://celoscan.io/tx/" + confirmedHash);
  console.info("Receipt status:", receipt.status);
  console.info("Attribution tag present:", tagPresent, attribution);

  // Machine-readable summary lines the workflow lifts into the run summary.
  // Never print keys here.
  console.info("SUMMARY_AGENT_ID=" + (registeredLog ? registeredLog.args.agentId.toString() : "unknown"));
  console.info("SUMMARY_TX_HASH=" + confirmedHash);
  console.info("SUMMARY_ATTRIBUTION=" + (tagPresent ? "tag present: " + config.attributionTag : "tag NOT found"));
}

registerIdentity().catch((error) => {
  console.error("ERC-8004 registration script failed:", error);
  process.exitCode = 1;
});
