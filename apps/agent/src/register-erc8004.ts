import {
  createPublicClient,
  createWalletClient,
  http
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { withAttribution, verifyTx } from "@celo/attribution-tags";
import { CELO_RPC_DEFAULT, ERC8004_IDENTITY_REGISTRY } from "@pocket/core";
import { readAgentConfig, assertAttributionTag } from "./config.js";

const registerAbi = [{
  type: "function",
  name: "register",
  stateMutability: "nonpayable",
  inputs: [{ name: "agentURI", type: "string" }],
  outputs: [{ name: "agentId", type: "uint256" }]
}] as const;

async function registerIdentity() {
  const config = readAgentConfig();
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

  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http(config.rpcUrl || CELO_RPC_DEFAULT)
  }).extend(withAttribution(config.attributionTag));

  const registration = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Pocket Agent",
    description: "A Celo mainnet agent that executes owner-approved recurring USDt to cNGN payments through Altana session keys and Textile FX."
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
  const attribution = await verifyTx({ client: publicClient, hash });
  console.info("ERC-8004 registration transaction:", "https://celoscan.io/tx/" + hash);
  console.info("Receipt status:", receipt.status);
  console.info("Attribution tag present:", Boolean(attribution?.codes.includes(config.attributionTag)), attribution);
  console.info("Read Registered(agentId) from the receipt to save the identity number.");
}

registerIdentity().catch((error) => {
  console.error("ERC-8004 registration script failed:", error);
  process.exitCode = 1;
});
