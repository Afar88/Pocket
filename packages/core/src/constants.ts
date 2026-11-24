import type { Address } from "viem";

export const CELO_CHAIN_ID = 42220;
export const CELO_RPC_DEFAULT = "https://celo-rpc.publicnode.com";
export const CELOSCAN_TX = "https://celoscan.io/tx/";

export const CELO_USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Address;
export const CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f" as Address;
export const TEXTILE_REACTOR = "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3" as Address;
export const ERC8004_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address;
export const ALTANA_KEYSTORE = "0x83b30935f36d6ccf9B1ec3b5E47F2866b97cd27c" as Address;

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }]
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
] as const;

export const ALTANA_KEYSTORE_ABI = [
  {
    type: "function",
    name: "isValidKey",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
] as const;

export const POCKET_REGISTRY_ABI = [
  {
    type: "function",
    name: "pocketCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "getPocket",
    stateMutability: "view",
    inputs: [{ name: "pocketId", type: "uint256" }],
    outputs: [{
      name: "pocket",
      type: "tuple",
      components: [
        { name: "owner", type: "address" },
        { name: "recipient", type: "address" },
        { name: "amountUsdt", type: "uint256" },
        { name: "period", type: "uint64" },
        { name: "nextDue", type: "uint64" },
        { name: "label", type: "string" },
        { name: "paused", type: "bool" },
        { name: "deleted", type: "bool" },
        { name: "agent", type: "address" },
        { name: "sessionKeyId", type: "bytes32" },
        { name: "sessionExpiry", type: "uint64" },
        { name: "usdtDailyCap", type: "uint128" },
        { name: "cngnDailyCap", type: "uint128" }
      ]
    }]
  },
  {
    type: "function",
    name: "createPocket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amountUsdt", type: "uint256" },
      { name: "period", type: "uint64" },
      { name: "firstDue", type: "uint64" },
      { name: "label", type: "string" }
    ],
    outputs: [{ name: "pocketId", type: "uint256" }]
  },
  {
    type: "function",
    name: "updatePocket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pocketId", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "amountUsdt", type: "uint256" },
      { name: "period", type: "uint64" },
      { name: "firstDue", type: "uint64" },
      { name: "label", type: "string" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "pausePocket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pocketId", type: "uint256" },
      { name: "paused", type: "bool" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "deletePocket",
    stateMutability: "nonpayable",
    inputs: [{ name: "pocketId", type: "uint256" }],
    outputs: []
  },
  {
    type: "function",
    name: "approveAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pocketId", type: "uint256" },
      { name: "agent", type: "address" },
      { name: "sessionKeyId", type: "bytes32" },
      { name: "sessionExpiry", type: "uint64" },
      { name: "usdtDailyCap", type: "uint128" },
      { name: "cngnDailyCap", type: "uint128" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "recordSwap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pocketId", type: "uint256" },
      { name: "txRef", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "markPaid",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pocketId", type: "uint256" },
      { name: "txRef", type: "bytes32" }
    ],
    outputs: []
  }
] as const;

export const POCKET_PAID_EVENT = {
  type: "event",
  name: "PocketPaid",
  anonymous: false,
  inputs: [
    { name: "pocketId", type: "uint256", indexed: true },
    { name: "txRef", type: "bytes32", indexed: false },
    { name: "nextDue", type: "uint64", indexed: false }
  ]
} as const;
