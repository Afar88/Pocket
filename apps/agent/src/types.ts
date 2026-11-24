import type { Address, Hex } from "viem";

export type PocketRecord = {
  id: bigint;
  owner: Address;
  recipient: Address;
  amountUsdt: bigint;
  period: bigint;
  nextDue: bigint;
  label: string;
  paused: boolean;
  deleted: boolean;
  agent: Address;
  sessionKeyId: Hex;
  sessionExpiry: bigint;
  usdtDailyCap: bigint;
  cngnDailyCap: bigint;
};

export type TxRequest = {
  to: Address;
  data: Hex;
  value: string;
  chainId: number;
};

export type FirmQuote = {
  rfqId: string;
  claimToken: string;
  taker: Address;
  reactor: Address;
  takerPays: bigint;
  buyAmount: bigint;
  expiresAt: string;
  approval: TxRequest;
  swap: TxRequest;
};

export type ExecuteResult = {
  status: "CONFIRMED" | "FAILED" | "PENDING";
  transactionHash?: Hex;
};

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
