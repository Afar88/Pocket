import type { Address } from "viem";

export const CELO_CHAIN_ID = 42220;
export const CELO_RPC_DEFAULT = "https://forno.celo.org";
export const CELOSCAN_TX = "https://celoscan.io/tx/";
export const CELOSCAN_ADDRESS = "https://celoscan.io/address/";

export const CELO_USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Address;
export const TEXTILE_REACTOR = "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3" as Address;
/** Textile Operator Vault fills: approve USDT to this executor and call fill((bytes,bytes)). Source: docs.textilecredit.com/protocol/address-book.html (Celo). */
export const TEXTILE_VAULT_EXECUTOR = "0x01b006d5c687bde182aa36F542f1f014144742e2" as Address;
export const ERC8004_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address;
export const ALTANA_KEYSTORE = "0x83b30935f36d6ccf9B1ec3b5E47F2866b97cd27c" as Address;

export type PocketCurrency = {
  code: string; name: string; symbol: string; address: Address; decimals: number; isUsdt: boolean;
};

export const POCKET_CURRENCIES: readonly PocketCurrency[] = [
  { code: "USD", name: "US Dollar", symbol: "USDT", address: CELO_USDT, decimals: 6, isUsdt: true },
  { code: "NGN", name: "Nigerian Naira", symbol: "cNGN", address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f" as Address, decimals: 6, isUsdt: false },
  { code: "ARS", name: "Argentine Peso", symbol: "wARS", address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D" as Address, decimals: 18, isUsdt: false },
  { code: "BRL", name: "Brazilian Real", symbol: "wBRL", address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0" as Address, decimals: 18, isUsdt: false },
  { code: "MXN", name: "Mexican Peso", symbol: "wMXN", address: "0x337E7456B420bD3481e7FA61fA9850343d610d34" as Address, decimals: 18, isUsdt: false },
  { code: "COP", name: "Colombian Peso (wrapped)", symbol: "wCOP", address: "0x8a1D45e102e886510e891d2Ec656a708991e2D76" as Address, decimals: 18, isUsdt: false },
  { code: "COPM", name: "Colombian Peso", symbol: "COPM", address: "0xC92E8Fc2947E32F2B574CCA9F2F12097A71d5606" as Address, decimals: 18, isUsdt: false },
  { code: "IDR", name: "Indonesian Rupiah", symbol: "IDRX", address: "0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22" as Address, decimals: 2, isUsdt: false },
  { code: "GBP", name: "British Pound", symbol: "VGBP", address: "0x7aE4265eCfc1F31bc0e112DfcFE3D78E01f4BB7f" as Address, decimals: 18, isUsdt: false },
  { code: "CHF", name: "Swiss Franc", symbol: "VCHF", address: "0xc5eBeA9984c485EC5D58cA5a2D376620d93aF871" as Address, decimals: 18, isUsdt: false }
] as const;

export function currencyByToken(address: string): PocketCurrency | undefined {
  return POCKET_CURRENCIES.find((currency) => currency.address.toLowerCase() === address.toLowerCase());
}

export const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }
] as const;

export const ALTANA_KEYSTORE_ABI = [{
  type: "function", name: "isValidKey", stateMutability: "view",
  inputs: [{ name: "user", type: "address" }, { name: "keyId", type: "bytes32" }], outputs: [{ name: "", type: "bool" }]
}] as const;

export const ALTANA_SPEND_INFOS_ABI = [{
  type: "function", name: "spendInfos", stateMutability: "view",
  inputs: [{ name: "keyHash", type: "bytes32" }],
  outputs: [{
    name: "results", type: "tuple[]", components: [
      { name: "token", type: "address" }, { name: "period", type: "uint8" },
      { name: "limit", type: "uint256" }, { name: "spent", type: "uint256" },
      { name: "lastUpdated", type: "uint256" }, { name: "currentSpent", type: "uint256" },
      { name: "current", type: "uint256" }
    ]
  }]
}] as const;

export const POCKET_REGISTRY_ABI = [
  { type: "function", name: "pocketCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "getPocket", stateMutability: "view", inputs: [{ name: "pocketId", type: "uint256" }],
    outputs: [{ name: "pocket", type: "tuple", components: [
      { name: "owner", type: "address" }, { name: "recipient", type: "address" },
      { name: "amountUsdt", type: "uint256" }, { name: "payoutToken", type: "address" },
      { name: "period", type: "uint64" }, { name: "nextDue", type: "uint64" },
      { name: "label", type: "string" }, { name: "note", type: "string" },
      { name: "paused", type: "bool" }, { name: "closed", type: "bool" }, { name: "deleted", type: "bool" },
      { name: "agent", type: "address" }, { name: "sessionKeyId", type: "bytes32" },
      { name: "sessionExpiry", type: "uint64" }, { name: "usdtDailyCap", type: "uint128" },
      { name: "payoutDailyCap", type: "uint128" }, { name: "minOutPerUsdt", type: "uint128" },
      { name: "lastSkippedDue", type: "uint64" }, { name: "lastSkippedReason", type: "uint8" }, { name: "encryptedSessionKey", type: "bytes" },
      { name: "serializedSession", type: "string" }
    ] }]
  },
  {
    type: "function", name: "getLastPayment", stateMutability: "view", inputs: [{ name: "pocketId", type: "uint256" }],
    outputs: [{ name: "payment", type: "tuple", components: [
      { name: "payoutToken", type: "address" }, { name: "usdtSpent", type: "uint256" },
      { name: "amountOut", type: "uint256" }, { name: "txRef", type: "bytes32" }, { name: "timestamp", type: "uint64" }
    ] }]
  },
  {
    type: "function", name: "createPocket", stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" }, { name: "amountUsdt", type: "uint256" },
      { name: "payoutToken", type: "address" }, { name: "payoutDailyCap", type: "uint128" },
      { name: "period", type: "uint64" }, { name: "firstDue", type: "uint64" }, { name: "label", type: "string" },
      { name: "note", type: "string" }, { name: "minOutPerUsdt", type: "uint128" }
    ], outputs: [{ name: "pocketId", type: "uint256" }]
  },
  {
    type: "function", name: "updatePocket", stateMutability: "nonpayable",
    inputs: [
      { name: "pocketId", type: "uint256" }, { name: "recipient", type: "address" },
      { name: "amountUsdt", type: "uint256" }, { name: "payoutToken", type: "address" },
      { name: "payoutDailyCap", type: "uint128" }, { name: "period", type: "uint64" }, { name: "firstDue", type: "uint64" },
      { name: "label", type: "string" }, { name: "note", type: "string" }
    ], outputs: []
  },
  { type: "function", name: "setMinRate", stateMutability: "nonpayable", inputs: [{ name: "pocketId", type: "uint256" }, { name: "minOutPerUsdt", type: "uint128" }], outputs: [] },
  { type: "function", name: "pausePocket", stateMutability: "nonpayable", inputs: [{ name: "pocketId", type: "uint256" }, { name: "paused", type: "bool" }], outputs: [] },
  { type: "function", name: "deletePocket", stateMutability: "nonpayable", inputs: [{ name: "pocketId", type: "uint256" }], outputs: [] },
  {
    type: "function", name: "approveAgent", stateMutability: "nonpayable",
    inputs: [
      { name: "pocketId", type: "uint256" }, { name: "agent", type: "address" },
      { name: "sessionKeyId", type: "bytes32" }, { name: "sessionExpiry", type: "uint64" },
      { name: "usdtDailyCap", type: "uint128" }, { name: "payoutDailyCap", type: "uint128" },
      { name: "encryptedSessionKey", type: "bytes" }, { name: "serializedSession", type: "string" }
    ], outputs: []
  },
  {
    type: "function", name: "markPaid", stateMutability: "nonpayable",
    inputs: [
      { name: "pocketId", type: "uint256" }, { name: "payoutToken", type: "address" },
      { name: "usdtSpent", type: "uint256" }, { name: "amountOut", type: "uint256" },
      { name: "dueAt", type: "uint64" }, { name: "txRef", type: "bytes32" }
    ], outputs: []
  },
  { type: "function", name: "skipPocket", stateMutability: "nonpayable", inputs: [{ name: "pocketId", type: "uint256" }, { name: "reasonCode", type: "uint8" }], outputs: [] },
  { type: "event", name: "PocketCreated", anonymous: false, inputs: [
    { name: "pocketId", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true }, { name: "amountUsdt", type: "uint256", indexed: false },
    { name: "payoutToken", type: "address", indexed: false }, { name: "payoutDailyCap", type: "uint128", indexed: false }, { name: "period", type: "uint64", indexed: false },
    { name: "nextDue", type: "uint64", indexed: false }, { name: "label", type: "string", indexed: false },
    { name: "note", type: "string", indexed: false }
  ]},
  { type: "event", name: "PocketPaid", anonymous: false, inputs: [
    { name: "pocketId", type: "uint256", indexed: true }, { name: "payoutToken", type: "address", indexed: true },
    { name: "usdtSpent", type: "uint256", indexed: false }, { name: "amountOut", type: "uint256", indexed: false },
    { name: "txRef", type: "bytes32", indexed: false }, { name: "timestamp", type: "uint64", indexed: false },
    { name: "nextDue", type: "uint64", indexed: false }
  ]},
  { type: "event", name: "PocketSkipped", anonymous: false, inputs: [
    { name: "pocketId", type: "uint256", indexed: true }, { name: "reasonCode", type: "uint8", indexed: false },
    { name: "dueAt", type: "uint64", indexed: false }, { name: "timestamp", type: "uint64", indexed: false }
  ]}
] as const;

export const POCKET_CREATED_EVENT = POCKET_REGISTRY_ABI.find((item) => item.type === "event" && item.name === "PocketCreated")!;
export const POCKET_PAID_EVENT = POCKET_REGISTRY_ABI.find((item) => item.type === "event" && item.name === "PocketPaid")!;
export const POCKET_SKIPPED_EVENT = POCKET_REGISTRY_ABI.find((item) => item.type === "event" && item.name === "PocketSkipped")!;
