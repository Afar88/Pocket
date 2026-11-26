import type { Address, Hex } from "viem";

export type PocketRecord = {
  id: bigint;
  owner: Address;
  recipient: Address;
  amountUsdt: bigint;
  payoutToken: Address;
  period: bigint;
  nextDue: bigint;
  label: string;
  note: string;
  paused: boolean;
  closed: boolean;
  deleted: boolean;
  agent: Address;
  sessionKeyId: Hex;
  sessionExpiry: bigint;
  usdtDailyCap: bigint;
  payoutDailyCap: bigint;
  minOutPerUsdt: bigint;
  lastSkippedDue: bigint;
  lastSkippedReason: number;
  encryptedSessionKey: Hex;
  serializedSession: string;
};

export type TxRequest = { to: Address; data: Hex; value: string; chainId: number };
export type FirmQuote = {
  rfqId: string;
  claimToken: string;
  taker: Address;
  reactor: Address;
  takerPays: bigint;
  buyAmount: bigint;
  expiresAt: string;
  swap: TxRequest;
};
export type ExecuteResult = { status: "CONFIRMED" | "FAILED" | "PENDING"; transactionHash?: Hex };
export type AgentLogger = {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
};
export const consoleLogger: AgentLogger = {
  info: (message, data) => console.info(message, data ?? {}),
  warn: (message, data) => console.warn(message, data ?? {}),
  error: (message, data) => console.error(message, data ?? {})
};
