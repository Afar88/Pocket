"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createClient,
  serializeSession,
  keyHashForSessionOrKey,
  CELO,
  signerFromPrivateKey, signerFromPasskey } from "@altananetwork/sdk";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  http,
  isAddress,
  parseUnits,
  zeroHash,
  toEventSelector,
  type Address,
  type Hex
} from "viem";
import { celo } from "viem/chains";
import { generatePrivateKey } from "viem/accounts";
import {
  buildPocketSessionPolicy,
  CELO_CHAIN_ID,
  CELOSCAN_TX,
  CELO_RPC_DEFAULT,
  REGISTRY_DEPLOY_BLOCKS,
  CELO_USDT,
  ALTANA_SPEND_INFOS_ABI,
  ERC20_ABI,
  POCKET_CURRENCIES,
  MAX_USDT_DAILY_CAP,
  USDT_DAILY_CAP_CHOICES,
  POCKET_CREATED_EVENT,
  POCKET_PAID_EVENT,
  POCKET_SKIPPED_EVENT,
  POCKET_REGISTRY_ABI,
  sealToAgent,
  TEXTILE_REACTOR,
  TEXTILE_VAULT_EXECUTOR
} from "@pocket/core";

type AppConfig = {
  chainId: number;
  rpcUrl: string;
  registryAddress: string;
  attributionTag: string;
  agentEncPublicKey: string;
};
type PocketView = {
  id: bigint; owner: Address; recipient: Address; amountUsdt: bigint; payoutToken: Address;
  period: bigint; nextDue: bigint; label: string; note: string; paused: boolean; closed: boolean; deleted: boolean;
  agent: Address; sessionKeyId: Hex; sessionExpiry: bigint; usdtDailyCap: bigint; payoutDailyCap: bigint;
  minOutPerUsdt: bigint; lastSkippedDue: bigint; lastSkippedReason: number;
  encryptedSessionKey: Hex; serializedSession: string;
};
type SessionMeta = {
  publicKey: Hex; keyId: Hex; keyHash: Hex; expiry: number; usdtDailyCap: string;
  payoutDailyCaps: Record<string, string>; payoutTokens: Address[];
  encryptedSessionKey: Hex; serializedSession: string;
};
type WalletMove = { hash: string; time: string; direction: "in" | "out"; amount: string; symbol: string; other: string };

// Money in and out of the wallet, read from Celo through Blockscout's public
// index of the chain (no key, CORS open).
async function loadWalletMoves(address: string): Promise<WalletMove[]> {
  const base = "https://celo.blockscout.com/api/v2/addresses/" + address;
  const [tokenRes, txRes] = await Promise.all([
    fetch(base + "/token-transfers", { cache: "no-store" }),
    fetch(base + "/transactions", { cache: "no-store" })
  ]);
  if (!tokenRes.ok || !txRes.ok) throw new Error("Blockscout unavailable");
  const tokens = await tokenRes.json() as { items?: { transaction_hash: string; timestamp: string; from: { hash: string }; to: { hash: string }; token: { symbol?: string; decimals?: string | null }; total?: { value?: string; decimals?: string | null } }[] };
  const txs = await txRes.json() as { items?: { hash: string; timestamp: string; from: { hash: string }; to?: { hash: string } | null; value: string }[] };
  const me = address.toLowerCase();
  const moves: WalletMove[] = [];
  const seen = new Set<string>();
  for (const t of tokens.items ?? []) {
    const decimals = Number(t.total?.decimals ?? t.token.decimals ?? 18);
    const incoming = t.to.hash.toLowerCase() === me;
    const key = t.transaction_hash + t.token.symbol + t.total?.value;
    if (seen.has(key)) continue; seen.add(key);
    moves.push({ hash: t.transaction_hash, time: t.timestamp, direction: incoming ? "in" : "out", amount: formatUnits(BigInt(t.total?.value ?? "0"), decimals), symbol: t.token.symbol ?? "token", other: incoming ? t.from.hash : t.to.hash });
  }
  for (const tx of txs.items ?? []) {
    if (!tx.value || tx.value === "0") continue;
    if (moves.some((m) => m.hash === tx.hash && m.symbol === "CELO")) continue;
    const incoming = (tx.to?.hash ?? "").toLowerCase() === me;
    moves.push({ hash: tx.hash, time: tx.timestamp, direction: incoming ? "in" : "out", amount: formatUnits(BigInt(tx.value), 18), symbol: "CELO", other: incoming ? tx.from.hash : (tx.to?.hash ?? "") });
  }
  return moves.sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, 25);
}

type PaymentRow = {
  kind: "paid" | "skipped"; pocketId: string; txHash: Hex; blockNumber: bigint;
  transactionIndex: number; logIndex: number;
  payoutToken?: Address; usdtSpent?: bigint; amountOut?: bigint; timestamp?: bigint; reasonCode?: number;
};
type BlockscoutAddressLog = {
  transaction_hash: string;
  block_number: string | number;
  transaction_index?: string | number;
  index?: string | number;
  topics: string[];
  data: string;
};
type BlockscoutLogPage = {
  items?: BlockscoutAddressLog[];
  next_page_params?: Record<string, string | number | null> | null;
};
type ActivityCache = { payments: PaymentRow[]; walletMoves: WalletMove[] };

function sortPaymentRows(rows: PaymentRow[]): PaymentRow[] {
  return rows.sort((a, b) =>
    Number(b.blockNumber - a.blockNumber) ||
    b.transactionIndex - a.transactionIndex ||
    b.logIndex - a.logIndex
  );
}

// Blockscout indexes contract logs directly. Query only the two Pocket event
// signatures, then decode with the same ABI used by the on-chain RPC reader.
async function loadBlockscoutEventRows(
  registryAddress: Address,
  eventAbi: typeof POCKET_PAID_EVENT | typeof POCKET_SKIPPED_EVENT,
  ownIds: Set<string>
): Promise<PaymentRow[]> {
  const rows: PaymentRow[] = [];
  let cursor: Record<string, string | number | null> | null = null;
  let previousCursor = "";
  for (;;) {
    const params = new URLSearchParams({ topic: toEventSelector(eventAbi) });
    for (const [key, value] of Object.entries(cursor ?? {})) {
      if (value !== null && value !== undefined) params.set(key, String(value));
    }
    const response = await fetch(
      "https://celo.blockscout.com/api/v2/addresses/" + registryAddress + "/logs?" + params.toString(),
      { cache: "no-store" }
    );
    if (!response.ok) throw new Error("Blockscout logs unavailable");
    const page = await response.json() as BlockscoutLogPage;
    if (!Array.isArray(page.items)) throw new Error("Blockscout returned an invalid log page");

    for (const log of page.items) {
      if (!log.transaction_hash || !log.data || !Array.isArray(log.topics) || log.topics.length === 0) {
        throw new Error("Blockscout returned an incomplete log");
      }
      const decoded = decodeEventLog({
        abi: [eventAbi],
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]]
      });
      const common = {
        txHash: log.transaction_hash as Hex,
        blockNumber: BigInt(log.block_number),
        transactionIndex: Number(log.transaction_index ?? 0),
        logIndex: Number(log.index ?? 0)
      };
      if (decoded.eventName === "PocketPaid") {
        const args = decoded.args as {
          pocketId: bigint; payoutToken: Address; usdtSpent: bigint; amountOut: bigint; timestamp: bigint;
        };
        const pocketId = String(args.pocketId);
        if (ownIds.has(pocketId)) rows.push({
          kind: "paid", ...common, pocketId, payoutToken: args.payoutToken,
          usdtSpent: args.usdtSpent, amountOut: args.amountOut, timestamp: args.timestamp
        });
      } else if (decoded.eventName === "PocketSkipped") {
        const args = decoded.args as { pocketId: bigint; timestamp: bigint; reasonCode: number };
        const pocketId = String(args.pocketId);
        if (ownIds.has(pocketId)) rows.push({
          kind: "skipped", ...common, pocketId,
          timestamp: args.timestamp, reasonCode: Number(args.reasonCode)
        });
      }
    }

    const next = page.next_page_params;
    if (!next || Object.keys(next).length === 0) break;
    const cursorKey = JSON.stringify(next);
    if (cursorKey === previousCursor) throw new Error("Blockscout pagination did not advance");
    previousCursor = cursorKey;
    cursor = next;
  }
  return rows;
}

async function loadBlockscoutPocketPayments(
  registryAddress: Address,
  ownIds: Set<string>
): Promise<PaymentRow[]> {
  const [paid, skipped] = await Promise.all([
    loadBlockscoutEventRows(registryAddress, POCKET_PAID_EVENT, ownIds),
    loadBlockscoutEventRows(registryAddress, POCKET_SKIPPED_EVENT, ownIds)
  ]);
  return sortPaymentRows([...paid, ...skipped]);
}

// Keep the old deployment-block RPC scan as a fallback if Blockscout fails.
async function loadRpcPocketPayments(
  publicClient: any,
  registryAddress: Address,
  ownIds: Set<string>,
  latest: bigint
): Promise<PaymentRow[]> {
  const paidRows: PaymentRow[] = [];
  const skippedRows: PaymentRow[] = [];
  const floor = REGISTRY_DEPLOY_BLOCKS[registryAddress.toLowerCase()] ?? 0n;
  let end = latest;
  while (end >= floor) {
    const start = end - floor > 4_999n ? end - 4_999n : floor;
    const [paidLogs, skippedLogs] = await Promise.all([
      publicClient.getLogs({ address: registryAddress, event: POCKET_PAID_EVENT, fromBlock: start, toBlock: end }),
      publicClient.getLogs({ address: registryAddress, event: POCKET_SKIPPED_EVENT, fromBlock: start, toBlock: end })
    ]);
    for (const entry of paidLogs) if (ownIds.has(String(entry.args.pocketId))) paidRows.push({
      kind: "paid", pocketId: String(entry.args.pocketId), txHash: entry.transactionHash as Hex, blockNumber: entry.blockNumber,
      transactionIndex: Number(entry.transactionIndex), logIndex: Number(entry.logIndex),
      payoutToken: entry.args.payoutToken, usdtSpent: entry.args.usdtSpent, amountOut: entry.args.amountOut, timestamp: entry.args.timestamp
    });
    for (const entry of skippedLogs) if (ownIds.has(String(entry.args.pocketId))) skippedRows.push({
      kind: "skipped", pocketId: String(entry.args.pocketId), txHash: entry.transactionHash as Hex, blockNumber: entry.blockNumber,
      transactionIndex: Number(entry.transactionIndex), logIndex: Number(entry.logIndex),
      timestamp: entry.args.timestamp, reasonCode: Number(entry.args.reasonCode)
    });
    if (start === floor) break;
    end = start - 1n;
  }
  return sortPaymentRows([...paidRows, ...skippedRows]);
}

const LAST_WALLET_STORAGE_KEY = "pocket-last-wallet-address";
const activityStorageKey = (walletAddress: string) => "pocket-activity-" + walletAddress.toLowerCase();

function readCachedActivity(walletAddress: string): ActivityCache | null {
  try {
    const raw = window.localStorage.getItem(activityStorageKey(walletAddress));
    if (!raw) return null;
    const value = JSON.parse(raw) as { payments?: any[]; walletMoves?: WalletMove[] };
    const payments = (value.payments ?? []).map((item: any) => ({
      ...item,
      blockNumber: BigInt(item.blockNumber),
      transactionIndex: Number(item.transactionIndex ?? 0),
      logIndex: Number(item.logIndex ?? 0),
      ...(item.usdtSpent === undefined ? {} : { usdtSpent: BigInt(item.usdtSpent) }),
      ...(item.amountOut === undefined ? {} : { amountOut: BigInt(item.amountOut) }),
      ...(item.timestamp === undefined ? {} : { timestamp: BigInt(item.timestamp) })
    })) as PaymentRow[];
    return { payments, walletMoves: Array.isArray(value.walletMoves) ? value.walletMoves : [] };
  } catch {
    return null;
  }
}

function saveCachedActivity(walletAddress: string, updates: Partial<ActivityCache>) {
  try {
    const current = readCachedActivity(walletAddress) ?? { payments: [], walletMoves: [] };
    const next = { ...current, ...updates };
    window.localStorage.setItem(activityStorageKey(walletAddress), JSON.stringify(
      next,
      (_key, value) => typeof value === "bigint" ? value.toString() : value
    ));
  } catch { /* Keep live activity when browser storage is full. */ }
}

function sanitizeFeedback(value: string): string {
  return value
    .replace(/https?:\/\/\S*celoscan\.io\S*/gi, "Celoscan")
    .replace(/\b0x[a-f0-9]{40}\b/gi, "wallet")
    .replace(/\b0x[a-f0-9]{64}\b/gi, "transaction");
}

type ProgressStep = { label: string; state: "pending" | "active" | "done" | "stopped" };

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SESSION_SKIP_GRACE_SECONDS = 60 * 60;
const POCKET_EVENTS_ABI = [POCKET_CREATED_EVENT] as const;
function shortAddress(value: string): string { return value.length > 12 ? value.slice(0, 6) + "…" + value.slice(-4) : value; }
// Rebuild the agent key's public details from the newest live pocket
// approval. Returns null when no pocket carries a live key.
function sessionFromPockets(pockets: readonly PocketView[]): SessionMeta | null {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const live = pockets
    .filter((p) => !p.deleted && !p.closed && p.agent !== "0x0000000000000000000000000000000000000000" && p.sessionExpiry > now && p.encryptedSessionKey && p.encryptedSessionKey !== "0x" && p.serializedSession)
    .sort((a, b) => (a.sessionExpiry > b.sessionExpiry ? -1 : a.sessionExpiry < b.sessionExpiry ? 1 : 0));
  for (const p of live) {
    try {
      const stored = JSON.parse(p.serializedSession) as {
        publicKey: Hex; expiry: number;
        permissions?: { calls?: { to: string; signature?: string }[]; spend?: { token?: string; limit: string }[] };
      };
      const currencies = new Set(POCKET_CURRENCIES.map((c) => c.address.toLowerCase()));
      const payoutTokens = (stored.permissions?.calls ?? [])
        .filter((c) => c.signature === "transfer(address,uint256)" && currencies.has(c.to.toLowerCase()))
        .map((c) => c.to as Address);
      const payoutDailyCaps: Record<string, string> = {};
      for (const limit of stored.permissions?.spend ?? []) {
        if (limit.token && currencies.has(limit.token.toLowerCase())) payoutDailyCaps[limit.token.toLowerCase()] = limit.limit;
      }
      return {
        publicKey: stored.publicKey,
        keyId: p.sessionKeyId,
        keyHash: keyHashForSessionOrKey(stored.publicKey) as Hex,
        expiry: Number(stored.expiry),
        usdtDailyCap: p.usdtDailyCap.toString(),
        payoutDailyCaps,
        payoutTokens,
        encryptedSessionKey: p.encryptedSessionKey,
        serializedSession: p.serializedSession
      };
    } catch { /* unreadable record: try the next pocket */ }
  }
  return null;
}

// A small "i" button that shows its help text only when tapped.
function Info({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Close on any tap elsewhere, on scroll, or when another info opens.
    const close = () => setOpen(false);
    const onOther = (e: Event) => { if ((e as CustomEvent).detail !== text) setOpen(false); };
    const timer = window.setTimeout(() => document.addEventListener("click", close), 0);
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("pocket-info-open", onOther);
    return () => { window.clearTimeout(timer); document.removeEventListener("click", close); window.removeEventListener("scroll", close); window.removeEventListener("pocket-info-open", onOther); };
  }, [open, text]);
  return (
    <span className="info">
      <button type="button" className="info-button" aria-label="More info" aria-expanded={open} onClick={(e) => { e.stopPropagation(); if (!open) window.dispatchEvent(new CustomEvent("pocket-info-open", { detail: text })); setOpen((v) => !v); }}>i</button>
      {open && <span className="info-pop" role="note">{text}</span>}
    </span>
  );
}

// Pocket's kangaroo. A "Tap me" sign invites a tap; the about text shows
// one short line at a time in a thought cloud.
const ROO_LINES = [
  "Hi, I'm Roo! Pocket sends money to people you care about.",
  "You set who, how much and how often. I pay them on Celo.",
  "Dollars or their local currency. Your money stays with you until it's due.",
  "Pause or stop anytime. Tap New to start."
];
function Mascot() {
  const [line, setLine] = useState<number | null>(null);
  const tapRoo = () => setLine((v) => (v === null ? 0 : v + 1 < ROO_LINES.length ? v + 1 : null));
  return (
    <section className="mascot">
      {line !== null && (
        <button type="button" className="thought" aria-live="polite" onClick={tapRoo}>
          <span className="thought-text">{ROO_LINES[line]}</span>
          <span className="thought-count">{line + 1}/{ROO_LINES.length}</span>
          <span className="thought-dot one" aria-hidden="true" /><span className="thought-dot two" aria-hidden="true" />
        </button>
      )}
      <button type="button" className="mascot-button" aria-label="What is Pocket?" onClick={tapRoo}>
        <img src="/pocket-kangaroo.png" alt="Roo, Pocket's kangaroo" width={297} height={480} />
        {line === null && <span className="tap-sign">Tap me!</span>}
      </button>
    </section>
  );
}

type Tab = "home" | "new" | "pockets" | "key" | "activity";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "home", label: "Home", icon: "⌂" },
  { id: "new", label: "New", icon: "+" },
  { id: "pockets", label: "Pockets", icon: "▤" },
  { id: "key", label: "Key", icon: "⚿" },
  { id: "activity", label: "Activity", icon: "↻" }
];

const sessionStorageKey = (walletAddress: string) =>
  "pocket-session-" + walletAddress.toLowerCase();
const PERIODS = [
  { label: "Once", value: "0" },
  { label: "Weekly", value: "604800" },
  { label: "Monthly", value: "2592000" }
];

// A new passkey wallet only goes on chain with its first transaction. Until
// then Celo has no record of the passkey, so "Sign in" cannot find it. Keep
// the passkey's public details (wallet address, credential id, public key,
// rpId; no secrets) in this browser until the wallet is active.
const ALTANA_KEYSTORE_CONTROLLER = "0x47bA5fc2A5b0CcB24BA3fAC9D4B59400eE9fd1D6" as Address;
const CELO_USD_FEED = "0x0568fD19986748cEfF3301e55c0eb1E729E0Ab7e" as Address;
const ALTANA_FEE_ABI = [{ type: "function", name: "getRegistrationFeeInWei", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }] as const;
const CHAINLINK_ROUND_ABI = [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [
  { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" },
  { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" }] }] as const;
// datetime-local inputs read and write the phone's local time, not UTC.
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// A time picked for "now" is already a little in the past by the time the
// passkey prompt finishes. Treat anything within the last 30 minutes as now
// and schedule it a minute ahead; older times are still refused.
const NOW_GRACE_SECONDS = 1800n;
function dueFromInput(value: string, label: string): bigint {
  const picked = new Date(value).getTime();
  if (!value || Number.isNaN(picked)) throw new Error(`Pick a ${label}.`);
  const due = BigInt(Math.floor(picked / 1000));
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (due > now) return due;
  if (now - due <= NOW_GRACE_SECONDS) return now + 60n;
  throw new Error(`That ${label} has passed. Pick a time from now on.`);
}

const PENDING_PASSKEY_PREFIX = "pocket-passkey-pending:";
type PendingPasskey = { address: string; id: string; publicKey: Hex; rpId?: string };
function savePendingPasskey(record: PendingPasskey) {
  window.localStorage.setItem(PENDING_PASSKEY_PREFIX + record.address.toLowerCase(), JSON.stringify(record));
}
function readPendingPasskey(address: string): PendingPasskey | null {
  const raw = window.localStorage.getItem(PENDING_PASSKEY_PREFIX + address.toLowerCase());
  if (!raw) return null;
  try { return JSON.parse(raw) as PendingPasskey; } catch { return null; }
}
function clearPendingPasskey(address: string) {
  window.localStorage.removeItem(PENDING_PASSKEY_PREFIX + address.toLowerCase());
}
function passkeyLabel() {
  const now = new Date();
  return "Pocket " + now.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " +
    now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export default function PocketApp() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [sdk, setSdk] = useState<any>(null);
  const [wallet, setWallet] = useState<any>(null);
  const signedContextRef = useRef<{ client: any; wallet: any } | null>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // Older phone browsers: fall back to a hidden text field.
      const field = document.createElement("textarea");
      field.value = address; field.setAttribute("readonly", ""); field.style.position = "fixed"; field.style.opacity = "0";
      document.body.appendChild(field); field.select(); document.execCommand("copy"); document.body.removeChild(field);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }
  const [walletPending, setWalletPending] = useState(false);
  const [usdtBalance, setUsdtBalance] = useState("—");
  const [celoBalance, setCeloBalance] = useState("—");
  const [usdtDecimals, setUsdtDecimals] = useState(6);
  const [spendMeter, setSpendMeter] = useState<{ used: bigint; cap: bigint } | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [walletMoves, setWalletMoves] = useState<WalletMove[] | null>(null);
  const [pockets, setPockets] = useState<PocketView[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ title: string; steps: ProgressStep[] } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [historyUpdating, setHistoryUpdating] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("Weekly support");
  const [period, setPeriod] = useState("604800");
  const [payoutToken, setPayoutToken] = useState<Address>(POCKET_CURRENCIES[1]!.address);
  const [payoutCap, setPayoutCap] = useState("");
  const [minRate, setMinRate] = useState("");
  const [liveRate, setLiveRate] = useState<string | null>(null);
  const [rateLoading, setRateLoading] = useState(false);
  const [rateSource, setRateSource] = useState<"bid" | "last" | null>(null);
  const [receiverNote, setReceiverNote] = useState("");
  const [firstDue, setFirstDue] = useState(toLocalInput(Date.now() + 5 * 60_000));

  const [usdtCap, setUsdtCap] = useState("5");
  const [expiryDays, setExpiryDays] = useState("90");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRecipient, setEditRecipient] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editPeriod, setEditPeriod] = useState("604800");
  const [editPayoutToken, setEditPayoutToken] = useState<Address>(POCKET_CURRENCIES[1]!.address);
  const [editPayoutCap, setEditPayoutCap] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editMinRate, setEditMinRate] = useState("0");
  const [editDue, setEditDue] = useState("");

  const publicClient = useMemo(() => createPublicClient({
    chain: celo,
    transport: http(config?.rpcUrl || CELO_RPC_DEFAULT)
  }), [config?.rpcUrl]);

  // Altana's one-time Keystore fee, read live: a USD amount priced in CELO.
  // A new wallet pays it once when its first pocket is created and once more
  // when it grants the agent key. The SDK sends 10% extra and refunds the rest.
  const [setupFee, setSetupFee] = useState<{ celo: string; usd: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [fee, round] = await Promise.all([
          publicClient.readContract({ address: ALTANA_KEYSTORE_CONTROLLER, abi: ALTANA_FEE_ABI, functionName: "getRegistrationFeeInWei" }),
          publicClient.readContract({ address: CELO_USD_FEED, abi: CHAINLINK_ROUND_ABI, functionName: "latestRoundData" })
        ]);
        const total = fee * 2n * 110n / 100n;
        const usdCents = Number(total * BigInt(round[1]) / 10n ** 24n);
        if (!cancelled) setSetupFee({ celo: Number(formatUnits(total, 18)).toFixed(1), usd: (usdCents / 100).toFixed(2) });
      } catch { if (!cancelled) setSetupFee(null); }
    })();
    return () => { cancelled = true; };
  }, [publicClient]);

  const registryAddress = config?.registryAddress as Address | undefined;
  const readyForWrites = Boolean(
    config?.registryAddress &&
    config?.attributionTag &&
    /^[a-z0-9_]{1,32}$/.test(config.attributionTag)
  );

  useEffect(() => {
    const savedAddress = window.localStorage.getItem(LAST_WALLET_STORAGE_KEY);
    if (!savedAddress || !isAddress(savedAddress)) return;
    const address = savedAddress as Address;
    // Restore only the public address. No passkey prompt runs on page load.
    setWallet({ address });
    setWalletPending(Boolean(readPendingPasskey(address)));
    const savedSession = window.localStorage.getItem(sessionStorageKey(address));
    if (savedSession) {
      try { setSessionMeta(JSON.parse(savedSession) as SessionMeta); }
      catch { window.localStorage.removeItem(sessionStorageKey(address)); }
    }
    const cached = readCachedActivity(address);
    if (cached) {
      setPayments(cached.payments);
      setWalletMoves(cached.walletMoves);
    }
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((response) => response.json())
      .then((data: AppConfig) => setConfig(data))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  useEffect(() => {
    const currency = POCKET_CURRENCIES.find((item) => item.address.toLowerCase() === payoutToken.toLowerCase());
    if (!currency || currency.isUsdt) {
      setLiveRate(null);
      setRateLoading(false);
      setMinRate("");
      return;
    }
    let cancelled = false;
    setLiveRate(null);
    setRateSource(null);
    // Read a fresh rate now and every minute while this currency is picked.
    const load = (first: boolean) => {
      if (first) setRateLoading(true);
      fetch("/api/rates?currency=" + encodeURIComponent(currency.code), { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("No live Textile rate is available for " + currency.symbol + ".");
          return await response.json() as { bid: string; source?: "bid" | "last" };
        })
        .then(({ bid, source }) => {
          if (cancelled) return;
          const live = parseUnits(bid, 18);
          const floor = live * 98n / 100n;
          setLiveRate(bid);
          setRateSource(source ?? "bid");
          if (first) setMinRate(formatUnits(floor, 18));
        })
        .catch(() => {
          if (!cancelled && first) { setLiveRate(null); setRateSource(null); setMinRate(""); }
        })
        .finally(() => { if (!cancelled && first) setRateLoading(false); });
    };
    load(true);
    const timer = window.setInterval(() => load(false), 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [payoutToken]);

  const beginProgress = (title: string, labels: string[]) => setProgress({ title, steps: labels.map((label, index) => ({ label, state: index === 0 ? "active" : "pending" })) });
  const advanceProgress = (index: number) => setProgress((current) => current ? ({ ...current, steps: current.steps.map((step, i) => ({ ...step, state: i < index ? "done" : i === index ? "active" : "pending" })) }) : current);
  const finishProgress = () => {
    setProgress((current) => current ? { ...current, steps: current.steps.map((step) => ({ ...step, state: "done" })) } : current);
    window.setTimeout(() => setProgress((current) => current && current.steps.every((step) => step.state === "done") ? null : current), 6000);
  };
  const stopProgress = () => setProgress((current) => current ? { ...current, steps: current.steps.map((step) => step.state === "active" ? { ...step, state: "stopped" } : step) } : current);

  const requireWriteSetup = useCallback(() => {
    if (!readyForWrites) {
      throw new Error("Set ATTRIBUTION_TAG and REGISTRY_ADDRESS in the Pocket web service before using wallet actions.");
    }
    if (!wallet?.address) throw new Error("Sign in with your passkey wallet first.");
    // The address-only wallet is enough for public reads. A signer is attached
    // by ensureWriteWallet only when an action is ready to sign.
    return { client: sdk, activeWallet: wallet, registry: registryAddress as Address };
  }, [readyForWrites, sdk, wallet, registryAddress]);

  async function ensureWriteWallet() {
    if (!readyForWrites) {
      throw new Error("Set ATTRIBUTION_TAG and REGISTRY_ADDRESS in the Pocket web service before using wallet actions.");
    }
    const current = signedContextRef.current;
    if (current?.client && current.wallet?.signer) {
      return { client: current.client, activeWallet: current.wallet, registry: registryAddress as Address };
    }
    const expectedAddress = wallet?.address ?? window.localStorage.getItem(LAST_WALLET_STORAGE_KEY) ?? undefined;
    if (!expectedAddress) throw new Error("Sign in with your passkey wallet first.");
    const restored = await createWallet(true, expectedAddress, true);
    if (!restored?.client || !restored.wallet?.signer) throw new Error("Sign in with your passkey to continue.");
    return { client: restored.client, activeWallet: restored.wallet, registry: registryAddress as Address };
  }

  async function sendOwnerCalls(calls: readonly { to: Address; data: Hex; value: bigint }[]) {
    const { client, activeWallet } = await ensureWriteWallet();
    const result = await client.execute({
      wallet: activeWallet,
      signer: activeWallet.signer,
      calls: [...calls]
    });
    if (result.status !== "CONFIRMED" || !result.transactionHash) {
      throw new Error("Altana wallet action did not confirm: " + result.status);
    }
    clearPendingPasskey(activeWallet.address);
    setWalletPending(false);
    setMessage("Saved on Celo");
    return result.transactionHash as Hex;
  }
  // Full scan of every pocket owned by this wallet, not just the last-100
  // display window: granting or revoking a session must reach older pockets too.
  const listOwnPockets = useCallback(async (): Promise<PocketView[]> => {
    if (!wallet || !registryAddress) return [];
    const count = await publicClient.readContract({
      address: registryAddress, abi: POCKET_REGISTRY_ABI, functionName: "pocketCount"
    });
    const own: PocketView[] = [];
    for (let id = 1n; id <= count; id += 1n) {
      const record = await publicClient.readContract({
        address: registryAddress, abi: POCKET_REGISTRY_ABI, functionName: "getPocket", args: [id]
      });
      if (record.owner.toLowerCase() === wallet.address.toLowerCase()) {
        own.push({ id, ...record } as PocketView);
      }
    }
    return own;
  }, [wallet, registryAddress, publicClient]);

  const refreshActivity = useCallback(async (ownIds: Set<string>, latest: bigint) => {
    if (!wallet?.address || !registryAddress) return;
    setHistoryUpdating(true);
    const walletMovesTask = loadWalletMoves(wallet.address)
      .then((moves) => {
        setWalletMoves(moves);
        saveCachedActivity(wallet.address, { walletMoves: moves });
      })
      .catch(() => { /* Keep cached wallet activity visible. */ });
    try {
      let rows: PaymentRow[];
      try {
        rows = await loadBlockscoutPocketPayments(registryAddress, ownIds);
      } catch {
        rows = await loadRpcPocketPayments(publicClient, registryAddress, ownIds, latest);
      }
      setPayments(rows);
      saveCachedActivity(wallet.address, { payments: rows });
      setHistoryUnavailable(false);
    } catch {
      // Keep the saved list visible when both public indexers are unavailable.
      setHistoryUnavailable(true);
    } finally {
      await walletMovesTask;
      setHistoryUpdating(false);
    }
  }, [wallet?.address, registryAddress, publicClient]);

  const refresh = useCallback(async () => {
    if (!wallet?.address || !registryAddress) return;
    try {
      const [balance, tokenDecimals, count, latest, nativeBalance] = await Promise.all([
        publicClient.readContract({
          address: CELO_USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address]
        }),
        publicClient.readContract({ address: CELO_USDT, abi: ERC20_ABI, functionName: "decimals" }),
        publicClient.readContract({ address: registryAddress, abi: POCKET_REGISTRY_ABI, functionName: "pocketCount" }),
        publicClient.getBlockNumber(),
        publicClient.getBalance({ address: wallet.address })
      ]);
      setCeloBalance(Number(formatUnits(nativeBalance, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 }));
      setUsdtDecimals(Number(tokenDecimals));
      setUsdtBalance(formatUnits(balance, Number(tokenDecimals)));

      const own: PocketView[] = [];
      for (let id = 1n; id <= count; id += 1n) {
        const record = await publicClient.readContract({
          address: registryAddress,
          abi: POCKET_REGISTRY_ABI,
          functionName: "getPocket",
          args: [id]
        });
        if (record.owner.toLowerCase() === wallet.address.toLowerCase()) {
          own.push({ id, ...record } as PocketView);
        }
      }
      setPockets([...own].reverse());

      // Rebuild the public session details from the on-chain pocket records.
      const fromChain = sessionFromPockets(own);
      if (fromChain) {
        setSessionMeta((current) => {
          if (current && current.keyId.toLowerCase() === fromChain.keyId.toLowerCase()) return current;
          window.localStorage.setItem(sessionStorageKey(wallet.address), JSON.stringify(fromChain));
          return fromChain;
        });
      }

      const ownIds = new Set(own.map((p) => p.id.toString()));
      await refreshActivity(ownIds, latest);

      if (sessionMeta?.keyHash) {
        try {
          const infos = await publicClient.readContract({
            address: wallet.address, abi: ALTANA_SPEND_INFOS_ABI, functionName: "spendInfos", args: [sessionMeta.keyHash]
          });
          const today = Math.floor(Date.now() / 86_400_000) * 86_400;
          const usdtInfo = infos.find((item) => item.token.toLowerCase() === CELO_USDT.toLowerCase() && Number(item.period) === 2 && Number(item.current) === today);
          setSpendMeter({ used: usdtInfo?.currentSpent ?? 0n, cap: usdtInfo?.limit ?? BigInt(sessionMeta.usdtDailyCap) });
        } catch { setSpendMeter(null); }
      } else {
        setSpendMeter(null);
      }
    } catch (reason) {
      setError(sanitizeFeedback(reason instanceof Error ? reason.message : String(reason)));
    }
  }, [wallet?.address, registryAddress, publicClient, refreshActivity, sessionMeta?.keyHash, sessionMeta?.usdtDailyCap]);

  useEffect(() => {
    if (!wallet?.address || !registryAddress) return;
    void refresh();
    let interval: number | null = null;
    const stop = () => {
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };
    const start = () => {
      if (interval === null) interval = window.setInterval(() => { void refresh(); }, 30_000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh, wallet?.address, registryAddress]);
  async function createWallet(
    recover: boolean,
    expectedAddress?: string,
    quiet = false
  ): Promise<{ client: any; wallet: any; pending: boolean } | null> {
    if (!quiet) {
      setBusy(true);
      beginProgress(recover ? "Passkey sign-in" : "Create passkey wallet", [recover ? "Connecting passkey wallet" : "Creating passkey wallet"]);
    }
    setError("");
    try {
      if (!config?.attributionTag) throw new Error("ATTRIBUTION_TAG must be configured before creating or changing wallets.");
      const client = createClient({ chains: [CELO], appCode: config.attributionTag });
      const rpId = window.location.hostname;
      let result: any;
      let pending = false;
      if (recover) {
        try {
          result = await client.recoverFromPasskey({ rpId });
        } catch (reason) {
          // Not on chain yet: rebuild it from public details saved on this browser.
          const text = reason instanceof Error ? reason.message : String(reason);
          const found = /resolves to wallet (0x[0-9a-fA-F]{40})/.exec(text);
          const saved = found?.[1] ? readPendingPasskey(found[1]) : null;
          if (!found || !text.includes("no keys registered")) throw reason;
          if (!saved) {
            throw new Error("This wallet was never activated, and this browser has no saved copy of it. Create a new passkey wallet. Nothing on chain is lost.");
          }
          result = {
            address: saved.address,
            signer: signerFromPasskey({ kind: "webauthn", id: saved.id, publicKey: saved.publicKey, ...(saved.rpId ? { rpId: saved.rpId } : {}) })
          };
          pending = true;
        }
      } else {
        result = await client.createPasskeyWallet({ name: passkeyLabel(), rpId });
        const credential = result.signer?.credential;
        if (credential?.kind === "webauthn") {
          savePendingPasskey({ address: result.address, id: credential.id, publicKey: credential.publicKey, rpId: credential.rpId ?? rpId });
        }
        pending = true;
      }
      if (expectedAddress && result.address.toLowerCase() !== expectedAddress.toLowerCase()) {
        throw new Error("That passkey belongs to a different wallet. Sign in with the saved wallet.");
      }
      if (recover && !pending && readPendingPasskey(result.address)) clearPendingPasskey(result.address);
      setWalletPending(pending);
      setSdk(client);
      setWallet(result);
      signedContextRef.current = { client, wallet: result };
      window.localStorage.setItem(LAST_WALLET_STORAGE_KEY, result.address);
      const key = sessionStorageKey(result.address);
      // Keep legacy records under a shared key so the wallet that owns the
      // grant can still revoke it, whichever wallet connects first.
      const legacy = window.localStorage.getItem("pocket-session");
      if (legacy) {
        window.localStorage.setItem("pocket-session-legacy", legacy);
        window.localStorage.removeItem("pocket-session");
      }
      const saved = window.localStorage.getItem(key)
        ?? window.localStorage.getItem("pocket-session-legacy");
      if (saved) {
        try { setSessionMeta(JSON.parse(saved) as SessionMeta); }
        catch { window.localStorage.removeItem(key); setSessionMeta(null); }
      } else {
        setSessionMeta(null);
      }
      const cached = readCachedActivity(result.address);
      setPayments(cached?.payments ?? []);
      setWalletMoves(cached?.walletMoves ?? null);
      setPockets([]);
      setUsdtBalance("—");
      setCeloBalance("—");
      if (!quiet) finishProgress();
      setMessage(pending ? "Wallet created. Finish setup on this device." : "Wallet ready");
      return { client, wallet: result, pending };
    } catch (reason) {
      const text = sanitizeFeedback(reason instanceof Error ? reason.message : String(reason));
      setError(text);
      if (!quiet) stopProgress();
      if (quiet) throw reason;
      return null;
    } finally {
      if (!quiet) setBusy(false);
    }
  }

  async function signOut() {
    window.localStorage.removeItem(LAST_WALLET_STORAGE_KEY);
    signedContextRef.current = null;
    setSdk(null);
    setWallet(null);
    setWalletPending(false);
    setSessionMeta(null);
    setPockets([]);
    setPayments([]);
    setWalletMoves(null);
    setSpendMeter(null);
    setUsdtBalance("—");
    setCeloBalance("—");
    setHistoryUnavailable(false);
    setError("");
    setMessage("");
  }
  async function createPocket() {
    setBusy(true); setError(""); setMessage("");
    try {
      const { registry } = requireWriteSetup();
      if (!isAddress(recipient)) throw new Error("Enter a valid Celo recipient wallet address.");
      if (!label.trim()) throw new Error("Add a name for this pocket.");
      const currency = POCKET_CURRENCIES.find((item) => item.address.toLowerCase() === payoutToken.toLowerCase());
      if (!currency) throw new Error("Choose a currency from the verified list.");
      if (receiverNote.length > 80) throw new Error("The public note must be 80 characters or fewer.");
      const amountRaw = parseUnits(amount, usdtDecimals);
      if (!amount.trim()) throw new Error("Enter the USDT amount for this pocket.");
      if (!payoutCap.trim()) throw new Error("Enter the daily payout cap in the receiver currency.");
      const payoutCapRaw = parseUnits(payoutCap, currency.decimals);
      const floorRaw = minRate.trim() ? parseUnits(minRate, 18) : 0n;
      if (amountRaw <= 0n) throw new Error("Enter an amount above 0.");
      const due = dueFromInput(firstDue, "first payment time");
      if (amountRaw > parseUnits(MAX_USDT_DAILY_CAP, usdtDecimals)) throw new Error("Keep each pocket at or below " + MAX_USDT_DAILY_CAP + " USDT.");
      if (payoutCapRaw <= 0n) throw new Error("Set a positive daily payout cap.");
      const attachSession = keyCovers(payoutToken, payoutCapRaw);
      beginProgress("Create pocket", ["Saving pocket to Celo", "Confirming pocket receipt", ...(attachSession ? ["Attaching session to pocket"] : [])]);
      const createHash = await sendOwnerCalls([{
        to: registry,
        data: encodeFunctionData({
          abi: POCKET_REGISTRY_ABI,
          functionName: "createPocket",
          args: [recipient as Address, amountRaw, payoutToken, payoutCapRaw, BigInt(period), due, label.trim(), receiverNote.trim(), floorRaw]
        }),
        value: 0n
      }]);
      advanceProgress(1);

      // pocketCount+1 is racy across owners; read the real id from the
      // PocketCreated event in the confirmed transaction's logs.
      const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
      let createdId: bigint | null = null;
      for (const log of receipt.logs) {
        try {
          const event = decodeEventLog({ abi: POCKET_EVENTS_ABI, data: log.data, topics: log.topics });
          if (event.eventName === "PocketCreated" && event.args.owner.toLowerCase() === wallet.address.toLowerCase()) {
            createdId = event.args.pocketId;
          }
        } catch { /* not a PocketCreated log */ }
      }
      if (createdId === null) throw new Error("Pocket created, but its PocketCreated event was not found in the receipt.");

      // Legacy saved sessions predate sealed-key storage and cannot be
      // attached to a new pocket; only sessions carrying the encrypted
      // key and serialized session are.
      if (attachSession && sessionMeta) {
        advanceProgress(2);
        await sendOwnerCalls([{
          to: registry,
          data: encodeFunctionData({
            abi: POCKET_REGISTRY_ABI,
            functionName: "approveAgent",
            args: [
              createdId,
              wallet.address as Address,
              sessionMeta.keyId,
              BigInt(sessionMeta.expiry - SESSION_SKIP_GRACE_SECONDS),
              BigInt(sessionMeta.usdtDailyCap),
              payoutCapRaw,
              sessionMeta.encryptedSessionKey,
              sessionMeta.serializedSession
            ]
          }),
          value: 0n
        }]);
      }
      setRecipient(""); setAmount(""); setPayoutCap(""); setLabel("Weekly support"); setReceiverNote(""); setMinRate(""); setTab("pockets");
      if (!attachSession && sessionMeta) setMessage("Pocket saved. Your agent key doesn't cover it. Grant a new key to include it.");
      await refresh();
      finishProgress();
    } catch (reason) {
      stopProgress();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  function beginEdit(p: PocketView) {
    setEditingId(p.id.toString());
    setEditRecipient(p.recipient);
    setEditAmount(formatUnits(p.amountUsdt, usdtDecimals));
    setEditLabel(p.label);
    setEditPeriod(p.period.toString());
    setEditPayoutToken(p.payoutToken);
    const selected = POCKET_CURRENCIES.find((item) => item.address.toLowerCase() === p.payoutToken.toLowerCase());
    setEditPayoutCap(formatUnits(p.payoutDailyCap, selected?.decimals ?? 18));
    setEditNote(p.note);
    setEditMinRate(formatUnits(p.minOutPerUsdt, 18));
    setEditDue(toLocalInput(Number(p.nextDue) * 1000));
  }

  async function saveEdit(id: bigint) {
    setBusy(true); setError("");
    try {
      const { registry } = requireWriteSetup();
      if (!isAddress(editRecipient)) throw new Error("Enter a valid recipient address.");
      if (!editLabel.trim()) throw new Error("Add a name for this pocket.");
      if (editNote.length > 80) throw new Error("The public note must be 80 characters or fewer.");
      const currency = POCKET_CURRENCIES.find((item) => item.address.toLowerCase() === editPayoutToken.toLowerCase());
      if (!currency) throw new Error("Choose a currency from the verified list.");
      const amountRaw = parseUnits(editAmount, usdtDecimals);
      const payoutCapRaw = parseUnits(editPayoutCap, currency.decimals);
      if (amountRaw <= 0n || amountRaw > parseUnits(MAX_USDT_DAILY_CAP, usdtDecimals)) throw new Error("Keep each pocket between 0 and " + MAX_USDT_DAILY_CAP + " USDT.");
      if (payoutCapRaw <= 0n) throw new Error("Set a positive daily payout cap.");
      const due = dueFromInput(editDue, "next due time");
      await sendOwnerCalls([{
        to: registry,
        data: encodeFunctionData({
          abi: POCKET_REGISTRY_ABI,
          functionName: "updatePocket",
          args: [id, editRecipient as Address, amountRaw, editPayoutToken, payoutCapRaw, BigInt(editPeriod), due, editLabel.trim(), editNote.trim()]
        }),
        value: 0n
      }]);
      await sendOwnerCalls([{ to: registry, data: encodeFunctionData({ abi: POCKET_REGISTRY_ABI, functionName: "setMinRate", args: [id, parseUnits(editMinRate || "0", 18)] }), value: 0n }]);
      setEditingId(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  async function lowerFloor(p: PocketView) {
    setBusy(true); setError("");
    try {
      const { registry } = requireWriteSetup();
      await sendOwnerCalls([{ to: registry, data: encodeFunctionData({ abi: POCKET_REGISTRY_ABI, functionName: "setMinRate", args: [p.id, p.minOutPerUsdt * 98n / 100n] }), value: 0n }]);
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function setPaused(p: PocketView, paused: boolean) {
    setBusy(true); setError("");
    try {
      const { registry } = requireWriteSetup();
      await sendOwnerCalls([{
        to: registry,
        data: encodeFunctionData({ abi: POCKET_REGISTRY_ABI, functionName: "pausePocket", args: [p.id, paused] }),
        value: 0n
      }]);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  async function deletePocket(p: PocketView) {
    if (!window.confirm("Delete this pocket rule? It cannot be restored.")) return;
    setBusy(true); setError("");
    try {
      const { registry } = requireWriteSetup();
      await sendOwnerCalls([{
        to: registry,
        data: encodeFunctionData({ abi: POCKET_REGISTRY_ABI, functionName: "deletePocket", args: [p.id] }),
        value: 0n
      }]);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  // True when the saved agent key can pay a pocket in this currency with
  // this daily payout cap. The key's own per-currency cap is the limit; the
  // USDT cap bounds total spend across pockets.
  function keyCovers(token: Address, payoutDailyCap: bigint): boolean {
    if (!sessionMeta?.encryptedSessionKey || !sessionMeta.serializedSession) return false;
    if (sessionMeta.expiry - SESSION_SKIP_GRACE_SECONDS <= Math.floor(Date.now() / 1000)) return false;
    const key = token.toLowerCase();
    if (!sessionMeta.payoutTokens?.some((t) => t.toLowerCase() === key)) return false;
    return BigInt(sessionMeta.payoutDailyCaps?.[key] ?? "0") >= payoutDailyCap;
  }

  async function giveAgentAccess(p: PocketView) {
    setBusy(true); setError("");
    try {
      const { activeWallet, registry } = requireWriteSetup();
      if (!sessionMeta || !keyCovers(p.payoutToken, p.payoutDailyCap)) throw new Error("Your agent key doesn't cover this pocket. Grant a new key.");
      beginProgress("Give agent access", ["Adding pocket to agent key"]);
      await sendOwnerCalls([{
        to: registry,
        data: encodeFunctionData({
          abi: POCKET_REGISTRY_ABI,
          functionName: "approveAgent",
          args: [
            p.id,
            activeWallet.address as Address,
            sessionMeta.keyId,
            BigInt(sessionMeta.expiry - SESSION_SKIP_GRACE_SECONDS),
            BigInt(sessionMeta.usdtDailyCap),
            p.payoutDailyCap,
            sessionMeta.encryptedSessionKey,
            sessionMeta.serializedSession
          ]
        }),
        value: 0n
      }]);
      setMessage("Agent can now pay this pocket.");
      await refresh();
      finishProgress();
    } catch (reason) {
      stopProgress();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  async function grantSession() {
    setBusy(true); setError("");
    try {
      const { client, activeWallet, registry } = await ensureWriteWallet();
      const ownPockets = await listOwnPockets();
      if (!ownPockets.some((p) => !p.deleted && !p.closed)) throw new Error("Create at least one active pocket before granting the agent.");
      const secret = generatePrivateKey();
      const sessionSigner = signerFromPrivateKey(secret);
      const expiry = Math.floor(Date.now() / 1000) + Number(expiryDays) * 86_400;
      const registryPaymentCutoff = expiry - SESSION_SKIP_GRACE_SECONDS;
      if (registryPaymentCutoff <= Math.floor(Date.now() / 1000)) throw new Error("Choose a session expiry more than one hour from now.");
      const usdtLimit = parseUnits(usdtCap, usdtDecimals);
      if (usdtLimit <= 0n || usdtLimit > parseUnits(MAX_USDT_DAILY_CAP, usdtDecimals)) throw new Error("The USDT daily cap must be above zero and no more than " + MAX_USDT_DAILY_CAP + ".");
      const activePockets = ownPockets.filter((p) => !p.deleted && !p.closed);
      const existingCaps: Record<string, bigint> = {};
      for (const p of activePockets) {
        const key = p.payoutToken.toLowerCase();
        existingCaps[key] = (existingCaps[key] ?? 0n) + p.payoutDailyCap;
      }
      // Cover every Pocket currency, not only today's pockets, so pockets
      // added later can use this key with no new grant (and no new Altana
      // fee). The USDT cap bounds real spend; each currency's cap is set to
      // twice the USDT cap at the current Textile rate, so it never binds
      // first unless the rate doubles. A currency with no rate and no
      // pocket is left out and needs a new key.
      const payoutDailyCaps: Record<string, bigint> = {};
      const payoutTokens: Address[] = [];
      for (const currency of POCKET_CURRENCIES) {
        const key = currency.address.toLowerCase();
        if (currency.payable === false && !existingCaps[key]) continue;
        const existing = existingCaps[key] ?? 0n;
        let ceiling = 0n;
        if (currency.isUsdt) {
          ceiling = usdtLimit;
        } else {
          try {
            const response = await fetch("/api/rates?currency=" + encodeURIComponent(currency.code), { cache: "no-store" });
            if (response.ok) {
              const { bid } = await response.json() as { bid: string };
              const perUsdt = parseUnits(Number(bid).toFixed(currency.decimals), currency.decimals);
              ceiling = (perUsdt * usdtLimit * 2n) / 10n ** BigInt(usdtDecimals);
            }
          } catch { /* no rate: fall back to existing pockets only */ }
        }
        const cap = existing > ceiling ? existing : ceiling;
        if (cap > 0n) { payoutTokens.push(currency.address); payoutDailyCaps[key] = cap; }
      }
      const permissions = buildPocketSessionPolicy({ registryAddress: registry, usdtDailyCap: usdtLimit, payoutTokens, payoutDailyCaps });
      beginProgress("Grant session key", ["Granting session key", "Approving Textile signature checks", "Saving session limits to Celo"]);
      const session = await client.grantSession({
        wallet: activeWallet,
        signer: activeWallet.signer,
        sessionSigner,
        permissions,
        expiry,
        chainId: CELO_CHAIN_ID
      });
      if (!config?.agentEncPublicKey) {
        throw new Error("AGENT_ENC_PUBLIC_KEY is not set on the web service; the agent cannot receive session keys.");
      }
      // The session private key stays out of the browser: it is sealed to the
      // agent's X25519 public key and only the ciphertext goes onchain.
      const encryptedSessionKey = sealToAgent(config.agentEncPublicKey as Hex, secret);
      const serializedSession = JSON.stringify(serializeSession(session));
      const meta: SessionMeta = {
        publicKey: session.publicKey,
        keyId: session.keyId,
        expiry,
        usdtDailyCap: usdtLimit.toString(),
        keyHash: session.keyHash,
        payoutDailyCaps: Object.fromEntries(Object.entries(payoutDailyCaps).map(([key, value]) => [key, value.toString()])),
        payoutTokens,
        encryptedSessionKey,
        serializedSession
      };
      window.localStorage.setItem(sessionStorageKey(activeWallet.address), JSON.stringify(meta));
      setSessionMeta(meta);

      if (session.status !== "granted") {
        const failedLegs = session.legs
          .filter((leg: { status: string }) => leg.status === "FAILED")
          .map((leg: { kind: string; chainId: number; reason?: string }) =>
            leg.kind + " on chain " + leg.chainId + (leg.reason ? ": " + leg.reason : "")
          );
        throw new Error("Altana did not fully confirm the session grant. Revoke the session and grant again. " + failedLegs.join("; "));
      }

      advanceProgress(1);
      // The Textile reactor must be approved to call the wallet's ERC-1271
      // isValidSignature for this session key during settlement verification.
      if (payoutTokens.some((token) => token.toLowerCase() !== CELO_USDT.toLowerCase())) {
        const checkerApproval = await client.approveSignatureChecker({ wallet: activeWallet, signer: activeWallet.signer, session, checker: TEXTILE_REACTOR, chainId: CELO_CHAIN_ID });
        if (checkerApproval.status !== "CONFIRMED") throw new Error("Textile reactor signature-checker approval did not confirm: " + checkerApproval.status);
      }

      advanceProgress(2);
      const calls = ownPockets.filter((p) => !p.deleted && !p.closed).map((p) => ({
        to: registry,
        data: encodeFunctionData({
          abi: POCKET_REGISTRY_ABI,
          functionName: "approveAgent",
          args: [p.id, activeWallet.address as Address, session.keyId, BigInt(registryPaymentCutoff), usdtLimit, p.payoutDailyCap, encryptedSessionKey, serializedSession]
        }),
        value: 0n
      }));
      if (calls.length) await sendOwnerCalls(calls);

      setMessage("Session granted. The agent can pay your pockets until the key expires or you revoke it.");
      await refresh();
      finishProgress();
    } catch (reason) {
      stopProgress();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  async function revokeSession() {
    setBusy(true); setError("");
    try {
      const { client, activeWallet, registry } = await ensureWriteWallet();
      if (!sessionMeta) throw new Error("No saved session key is available in this browser.");
      beginProgress("Revoke session key", ["Revoking session key", "Clearing pocket access"]);
      const revoked = await client.revokeSession({
        wallet: activeWallet,
        signer: activeWallet.signer,
        session: sessionMeta.publicKey
      });
      if (revoked.status !== "revoked") {
        throw new Error("Altana did not confirm revocation. Check the returned session status before continuing.");
      }
      advanceProgress(1);
      const ownPockets = await listOwnPockets();
      const calls = ownPockets
        .filter((p) => !p.deleted && p.sessionKeyId.toLowerCase() === sessionMeta.keyId.toLowerCase())
        .map((p) => ({
          to: registry,
          data: encodeFunctionData({
            abi: POCKET_REGISTRY_ABI,
            functionName: "approveAgent",
            args: [p.id, ZERO, zeroHash, 0n, 0n, 0n, "0x" as Hex, ""]
          }),
          value: 0n
        }));
      if (calls.length) await sendOwnerCalls(calls);
      window.localStorage.removeItem(sessionStorageKey(activeWallet.address));
      setSessionMeta(null);
      setMessage("Session revoked. The agent can no longer use this key.");
      await refresh();
      finishProgress();
    } catch (reason) {
      stopProgress();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  const dateText = (timestamp: bigint) => new Date(Number(timestamp) * 1000).toLocaleString();
  const periodText = (seconds: bigint) => seconds === 0n ? "Once" : seconds === 604_800n ? "Weekly" : seconds === 2_592_000n ? "Monthly" : "Every " + (Number(seconds) / 86_400) + " days";
  const pocketStatus = (p: PocketView) => p.closed ? "Completed" : p.paused ? "Paused" : p.sessionExpiry > 0n && p.sessionExpiry <= BigInt(Math.floor(Date.now() / 1000)) ? "Session expired" : p.agent === ZERO ? "Session not granted" : "Active";
  const activePockets = pockets.filter((p) => !p.deleted && !p.closed);
  const completedPockets = pockets.filter((p) => !p.deleted && p.closed);
  const paidReceiptFor = (p: PocketView) => payments.find((item) => item.kind === "paid" && item.pocketId === p.id.toString());

  const sessionIsExpired = Boolean(sessionMeta && sessionMeta.expiry <= Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 4_000);
    return () => window.clearTimeout(timer);
  }, [message]);

  return (
    <main>
      <header>
        <div className="brand">
          <div className="mark">P</div>
          <div>
            <h1>Pocket</h1>
            <p className="sub">Your money. Your rules. Celo mainnet.</p>
          </div>
        </div>
        <span className={"pill status " + (!wallet ? "off" : walletPending ? "pending" : wallet?.signer ? "on" : "readonly")}><span className="dot" aria-hidden="true" />{!wallet ? "Signed out" : walletPending ? "Not active" : wallet?.signer ? "Connected" : "Read-only"}</span>
      </header>

      {tab === "home" && <Mascot />}

      {!config?.registryAddress && (
        <div className="notice">PocketRegistry is not set yet. Deploy the contract on Celo mainnet, then add REGISTRY_ADDRESS to both Render services.</div>
      )}
      {!config?.attributionTag && (
        <div className="notice">ATTRIBUTION_TAG is empty. Wallet actions and agent payments stay blocked until you add your Celo attribution code.</div>
      )}
      {config && !config.agentEncPublicKey && (
        <div className="notice">AGENT_ENC_PUBLIC_KEY is not set. Session grants are disabled until the agent encryption public key is configured.</div>
      )}
      {(error || message) && <div className="toast-stack" aria-live="polite">
        {error && <div className="toast toast-error" role="alert"><span>{sanitizeFeedback(error)}</span><button type="button" className="toast-close" aria-label="Close error" onClick={() => setError("")}>×</button></div>}
        {message && <div className="toast toast-success" role="status"><span>{message}</span><button type="button" className="toast-close" aria-label="Close message" onClick={() => setMessage("")}>×</button></div>}
      </div>}
      {progress && <section className="panel progress-panel progress-sheet" aria-live="polite"><div className="progress-heading"><h2>{progress.title}</h2><span className="progress-state">{progress.steps.every((s) => s.state === "done") ? "Done" : progress.steps.some((s) => s.state === "stopped") ? "Stopped" : "In progress"}</span>{(progress.steps.every((s) => s.state === "done") || progress.steps.some((s) => s.state === "stopped")) && <button type="button" className="sheet-close" aria-label="Close" onClick={() => setProgress(null)}>×</button>}</div><ol className="progress-list">{progress.steps.map((step, index) => <li className={"progress-step " + step.state} key={step.label}><span className="step-index">{step.state === "done" ? "✓" : String(index + 1).padStart(2, "0")}</span><span>{step.label}</span><span className="step-state">{step.state === "active" ? "Working" : step.state === "done" ? "Done" : step.state === "stopped" ? "Stopped" : ""}</span></li>)}</ol></section>}

      {tab === "home" && <>
      <section className="panel sample-panel"><div className="sample-heading"><span className="sample-label">Sample</span><span className="small">Illustration only · no live payment</span></div><h2>One pocket, one payout</h2><p className="small">A calm walkthrough of what happens when a scheduled pocket is due.</p><div className="sample-flow"><div className="sample-step"><span className="sample-dot">01</span><div><strong>Pocket is due</strong><span>The schedule reaches its next payout time.</span></div></div><div className="sample-step"><span className="sample-dot">02</span><div><strong>Textile swaps USDT to cNGN</strong><span>The wallet stays in control through its limited session.</span></div></div><div className="sample-step"><span className="sample-dot">03</span><div><strong>Recipient gets cNGN</strong><span>The confirmed payout is recorded on Celo.</span></div></div></div></section>

      <section className="panel hero">
        <div>
          <p className="small">USDt in your Altana wallet <Info text="Funds stay in your wallet until a pocket is due." /></p>
          <div className="balance">{usdtBalance === "—" ? "—" : usdtBalance + " USDt"}</div>
          {wallet && <p className="meta">CELO for fees: {celoBalance === "—" ? "—" : celoBalance + " CELO"} <Info text={setupFee ? "New wallets pay about " + setupFee.celo + " CELO (about $" + setupFee.usd + ") once for Altana setup: one fee for the first pocket, one for the agent key. Each new agent key costs about half that again." : "CELO pays Altana's setup fees and network fees."} /></p>}
          {wallet && <p className="meta">Wallet: <code>{wallet.address}</code> <button type="button" className="secondary" onClick={() => void copyAddress(wallet.address)}>{copied ? "Copied" : "Copy"}</button></p>}
          {wallet && walletPending && <div className="notice">Not active yet. Add a little USDt{setupFee ? ", plus about " + setupFee.celo + " CELO (about $" + setupFee.usd + ") for Altana's one-time setup" : ", plus CELO for Altana's one-time setup"}. Then create a pocket here. Until then, only this browser can open this wallet.</div>}
        </div>
        <div className="actions">
          <button disabled={busy || !config?.attributionTag} onClick={() => void createWallet(false)}>Create passkey wallet</button>
          <button className="secondary" disabled={busy || !config?.attributionTag} onClick={() => void createWallet(true)}>Sign in</button>
          {wallet && <button className="secondary" disabled={busy} onClick={() => void refresh()}>Refresh</button>}
          {wallet && <button className="secondary" disabled={busy} onClick={() => void signOut()}>Sign out</button>}
        </div>
      </section>

      </>}
        {tab === "new" && <section className="panel form-panel">
          <h2>New pocket <Info text="Set who gets paid, how much, and how often. USDT goes straight across; other currencies are swapped through Textile at payout time." /></h2>
          <label>Name</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} placeholder="Family upkeep" />
          <label>Recipient wallet</label>
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x..." />
          <label>Receiver gets <Info text="MiniPay shows dollars only." /></label>
          <select value={payoutToken} onChange={(e) => { const value=e.target.value as Address; setPayoutToken(value); const currency=POCKET_CURRENCIES.find((item)=>item.address.toLowerCase()===value.toLowerCase()); if(currency) setPayoutCap(""); }}>
            {POCKET_CURRENCIES.filter((currency)=>currency.payable!==false).map((currency)=><option key={currency.address} value={currency.address}>{currency.name} ({currency.symbol})</option>)}
          </select>
          <div className="row">
            <div><label>USDT amount <Info text="Keep it within your agent's daily limit, which also covers small relay fees." /></label><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></div>
            <div><label>Repeat</label><select value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></div>
          </div>
          <label>Daily payout cap ({POCKET_CURRENCIES.find((item)=>item.address.toLowerCase()===payoutToken.toLowerCase())?.symbol})</label>
          <input value={payoutCap} onChange={(e)=>setPayoutCap(e.target.value)} inputMode="decimal"/>
          <label>Minimum rate floor (local currency per USDT) <Info text={(POCKET_CURRENCIES.find((item) => item.address.toLowerCase() === payoutToken.toLowerCase())?.isUsdt ? "USDT goes across 1:1. No rate needed." : rateLoading ? "Fetching live Textile rate…" : liveRate ? (rateSource === "last" ? "Last Textile trade: " : "Live Textile rate: ") + liveRate + " " + (POCKET_CURRENCIES.find((item) => item.address.toLowerCase() === payoutToken.toLowerCase())?.symbol ?? "") + " per USDT. Updates every minute." : "Textile rate unavailable right now. Set a floor or leave 0 (off).") + " A payout waits if the rate is below your floor."} /></label><input value={minRate} onChange={(e) => setMinRate(e.target.value)} inputMode="decimal" placeholder="0 = off"/>
          <label>Note to receiver <Info text="Public on the blockchain. Up to 80 characters." /></label><textarea maxLength={80} value={receiverNote} onChange={(e)=>setReceiverNote(e.target.value)} placeholder="A short public message"/>
          <label>First payment date and time</label>
          <input type="datetime-local" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
          <button disabled={busy || rateLoading || !wallet || !readyForWrites} onClick={() => void createPocket()}>Create pocket</button>
        </section>}

        {tab === "key" && <section className="panel session-panel">
          <div className="section-heading"><div><h2>Agent key <Info text="A limited key that lets Pocket's agent pay your pockets. It can only send in your pocket currencies, let Textile swap USDT, and mark pockets paid or skipped. It can't edit your pockets, and it never spends more than your daily limit, fees included. It's locked so only the agent can open it." /></h2></div>{sessionMeta && <span className={"status-pill " + (sessionIsExpired ? "expired" : "active")}>{sessionIsExpired ? "Expired" : "Active"}</span>}</div>
          {sessionMeta ? <div className="session-summary"><div className="limit-grid"><div className="limit-tile"><span>Daily USDT cap</span><strong className="mono">{formatUnits(BigInt(sessionMeta.usdtDailyCap), usdtDecimals)} USDT</strong></div><div className="limit-tile"><span>Session spend</span><strong className="mono">{spendMeter ? "Today: $" + formatUnits(spendMeter.used, usdtDecimals) + " of $" + formatUnits(spendMeter.cap, usdtDecimals) + " used, expires " + new Date(sessionMeta.expiry * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "Spend unavailable"}</strong></div></div><div className="session-detail"><span>Expiry</span><strong>{new Date(sessionMeta.expiry * 1000).toLocaleString()}</strong></div><div className="session-detail"><span>Key ID</span><code>{shortAddress(sessionMeta.keyId)}</code></div><div className="contract-list"><span className="contract-heading">Allowed contracts</span><div className="contract-item"><span>Textile reactor · execute and signature check</span><code>{shortAddress(TEXTILE_REACTOR)}</code></div><div className="contract-item"><span>Textile vault executor · fill</span><code>{shortAddress(TEXTILE_VAULT_EXECUTOR)}</code></div><div className="contract-item"><span>USDT · approve</span><code>{shortAddress(CELO_USDT)}</code></div><div className="contract-item"><span>Currencies it can pay</span><code>{(sessionMeta.payoutTokens ?? []).map((token)=>POCKET_CURRENCIES.find((c)=>c.address.toLowerCase()===token.toLowerCase())?.symbol ?? shortAddress(token)).join(", ") || "Regrant session for v2 token permissions"}</code></div><div className="contract-item"><span>PocketRegistry · markPaid / skipPocket</span><code>{config?.registryAddress ? shortAddress(config.registryAddress) : "Unavailable"}</code></div></div><p className="small">Limits are enforced by the Altana session. USDT headroom includes relay fees. Revoke the key to stop the agent.</p><button className="danger revoke-button" disabled={busy || !wallet || !readyForWrites} onClick={() => void revokeSession()}>Revoke key</button></div> : <><p className="small">Set the limits before granting the agent access. You can revoke the key later.</p><div className="row">
            <div><label>USDT the agent can spend per day <Info text="One limit shared by all pockets on this key." /></label><select value={usdtCap} onChange={(e) => setUsdtCap(e.target.value)}>{USDT_DAILY_CAP_CHOICES.map((choice) => <option key={choice} value={choice}>{choice} USDT</option>)}</select></div>
          </div>
          <label>Key expires in <Info text="Each new key costs an Altana fee in CELO, so a longer key means fewer fees." /></label>
          <select value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)}>
            <option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">1 year</option>
          </select>
          <p className="meta">Contracts <Info text={"Textile: " + TEXTILE_REACTOR + " · USDT: " + CELO_USDT + " · Registry: " + (config?.registryAddress || "Not deployed")} /></p>
              <button disabled={busy || !wallet || !readyForWrites || pockets.length === 0} onClick={() => void grantSession()}>Grant session key</button>
            </>}
        </section>}


      {tab === "pockets" && <section className="panel pockets-panel">
        <div className="section-heading"><div><h2>Your pockets <Info text="Rules are on Celo. Funds stay in your wallet until payout." /></h2></div>{wallet && <span className="count-pill">{activePockets.length + completedPockets.length} pockets</span>}</div>
        {!wallet && <p>Sign in with your passkey to see your pockets.</p>}
        {wallet && <>
          <div className="pocket-section-heading"><h3>Active</h3><span className="count-pill">{activePockets.length}</span></div>
          {activePockets.length === 0 && <p className="small">No active pockets.</p>}
          {activePockets.map((p) => (
            <div className="pocket-card" key={p.id.toString()}>
              <div className="pocket-top"><div className="pocket-title"><span className="eyebrow">POCKET <code>#{p.id.toString()}</code></span><h3>{p.label}</h3></div><span className={"status-pill " + (pocketStatus(p) === "Paused" ? "paused" : pocketStatus(p) === "Active" ? "active" : pocketStatus(p) === "Session expired" ? "expired" : "unassigned")}>{pocketStatus(p)}</span></div>
              <div className="pocket-amount"><span>Sender spends</span><strong className="mono">{formatUnits(p.amountUsdt, usdtDecimals)} USDT</strong></div>
              <div className="pocket-facts"><div><span>Receiver gets</span><strong>{POCKET_CURRENCIES.find((currency)=>currency.address.toLowerCase()===p.payoutToken.toLowerCase())?.symbol ?? "Unknown"}</strong></div><div><span>Recipient</span><code>{shortAddress(p.recipient)}</code></div><div><span>Frequency</span><strong>{periodText(p.period)}</strong></div><div><span>Next payout</span><strong>{dateText(p.nextDue)}</strong></div><div><span>Note</span><strong>{p.note || "—"}</strong></div><div><span>Rate floor</span><strong>{p.minOutPerUsdt>0n?formatUnits(p.minOutPerUsdt,18)+" / USDT":"Off"}</strong></div></div>
              {sessionMeta && p.sessionKeyId.toLowerCase() !== sessionMeta.keyId.toLowerCase() && (keyCovers(p.payoutToken, p.payoutDailyCap)
                ? <div className="notice">Agent can't pay this pocket yet. <button className="secondary" disabled={busy || !readyForWrites} onClick={()=>void giveAgentAccess(p)}>Give agent access</button></div>
                : <div className="notice">Agent key doesn't cover this pocket. Grant a new key.</div>)}
              {p.minOutPerUsdt>0n && p.lastSkippedDue===p.nextDue && p.lastSkippedReason===1 && <div className="notice">Held: rate below your floor. <button className="secondary" disabled={busy || !readyForWrites} onClick={()=>void lowerFloor(p)}>Lower floor</button></div>}
              {editingId === p.id.toString() ? (
                <div>
                  <label>Name</label><input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} />
                  <label>Recipient</label><input value={editRecipient} onChange={(e) => setEditRecipient(e.target.value)} />
                  <label>Receiver gets</label><select value={editPayoutToken} onChange={(e)=>{const token=e.target.value as Address;setEditPayoutToken(token);const currency=POCKET_CURRENCIES.find((item)=>item.address.toLowerCase()===token.toLowerCase());if(currency)setEditPayoutCap("");}}>{POCKET_CURRENCIES.filter((currency)=>currency.payable!==false).map((currency)=><option key={currency.address} value={currency.address}>{currency.name} ({currency.symbol})</option>)}</select>
                  <label>Daily payout cap ({POCKET_CURRENCIES.find((item)=>item.address.toLowerCase()===editPayoutToken.toLowerCase())?.symbol})</label><input value={editPayoutCap} onChange={(e)=>setEditPayoutCap(e.target.value)} inputMode="decimal"/>
                  <label>Note to receiver <Info text="Public on the blockchain. Up to 80 characters." /></label><textarea maxLength={80} value={editNote} onChange={(e)=>setEditNote(e.target.value)}/>
                  <label>Minimum rate floor (0 = off)</label><input value={editMinRate} onChange={(e)=>setEditMinRate(e.target.value)} inputMode="decimal"/>
                  <div className="row">
                    <div><label>USDt amount</label><input value={editAmount} onChange={(e) => setEditAmount(e.target.value)} /></div>
                    <div><label>Repeat</label><select value={editPeriod} onChange={(e) => setEditPeriod(e.target.value)}>{PERIODS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></div>
                  </div>
                  <label>Next due</label><input type="datetime-local" value={editDue} onChange={(e) => setEditDue(e.target.value)} />
                  <div className="actions">
                    <button disabled={busy} onClick={() => void saveEdit(p.id)}>Save changes</button>
                    <button className="secondary" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="actions">
                  <button className="secondary" disabled={busy || !readyForWrites} onClick={() => beginEdit(p)}>Edit</button>
                  <button className="secondary" disabled={busy || !readyForWrites || p.minOutPerUsdt===0n} onClick={()=>void lowerFloor(p)}>Lower floor</button>
                  <button className="secondary" disabled={busy || !readyForWrites} onClick={() => void setPaused(p, !p.paused)}>{p.paused ? "Resume" : "Pause"}</button>
                  <button className="danger" disabled={busy || !readyForWrites} onClick={() => void deletePocket(p)}>Delete</button>
                </div>
              )}
            </div>
          ))}
          <div className="completed-heading">
            <button type="button" className="secondary completed-toggle" aria-expanded={showCompleted} onClick={() => setShowCompleted((current) => !current)}>
              <span>{showCompleted ? "▾" : "▸"} Completed ({completedPockets.length})</span>
            </button>
          </div>
          {showCompleted && completedPockets.map((p) => {
            const receipt = paidReceiptFor(p);
            return <div className="pocket-card completed-card" key={p.id.toString()}>
              <div className="pocket-top"><div className="pocket-title"><span className="eyebrow">POCKET <code>#{p.id.toString()}</code></span><h3>{p.label}</h3></div><span className="status-pill active">Completed</span></div>
              <div className="pocket-amount"><span>Amount</span><strong className="mono">{formatUnits(p.amountUsdt, usdtDecimals)} USDT</strong></div>
              <div className="pocket-facts">
                <div><span>Recipient</span><code>{shortAddress(p.recipient)}</code></div>
                <div><span>Paid date</span><strong>{receipt?.timestamp ? dateText(receipt.timestamp) : "Not available"}</strong></div>
              </div>
              <div className="actions">
                {receipt ? <a className="receipt-link" href={"/r/" + p.id.toString() + "/" + receipt.txHash}>Receipt ↗</a> : <span className="small">Receipt not indexed yet</span>}
              </div>
            </div>;
          })}
        </>}
      </section>}

      {tab === "home" && <section className="panel how-panel"><h2>How it works</h2><div className="how-strip"><div className="how-step"><span>01</span><strong>Your wallet</strong><small>Funds stay with you</small></div><div className="how-arrow">→</div><div className="how-step"><span>02</span><strong>Altana session key</strong><small>With daily limits</small></div><div className="how-arrow">→</div><div className="how-step"><span>03</span><strong>Pocket agent</strong><small>ERC-8004 #10132</small></div><div className="how-arrow">→</div><div className="how-step"><span>04</span><strong>Textile FX swap</strong><small>USDT to cNGN</small></div><div className="how-arrow">→</div><div className="how-step"><span>05</span><strong>Recipient</strong><small>Gets cNGN</small></div></div></section>}

      {tab === "activity" && <section className="panel payments-panel">
        <h2>Activity <Info text="Read straight from Celo, newest first: money in and out of your wallet, then Pocket payments and skips. The agent checks about every 15 minutes; a late run still pays overdue pockets." /></h2>
        {historyUpdating && <p className="small activity-updating">Updating…</p>}
        <h3 className="activity-heading">Wallet</h3>
        {!wallet ? <p className="small">Sign in to see your wallet's activity.</p> : walletMoves === null ? <p className="small">Reading Celo…</p> : walletMoves.length === 0 ? <p className="small">No transfers yet.</p> :
          <ul className="list">{walletMoves.map((m) => <li className="payment-receipt" key={m.hash + m.symbol + m.amount}>
            <div className="receipt-top"><strong className={m.direction === "in" ? "move-in" : "move-out"}>{m.direction === "in" ? "+ " : "− "}{Number(m.amount).toLocaleString("en-US", { maximumFractionDigits: 6 })} {m.symbol}</strong><span className="small">{new Date(m.time).toLocaleString()}</span></div>
            <div className="receipt-line"><div><span>{m.direction === "in" ? "From" : "To"}</span><code>{shortAddress(m.other as Address)}</code></div><a className="receipt-link" href={CELOSCAN_TX + m.hash} target="_blank" rel="noreferrer">Celoscan ↗</a></div>
          </li>)}</ul>}
        <h3 className="activity-heading">Pocket payments</h3>
        {historyUnavailable && payments.length === 0 ? <p className="small">History unavailable right now.</p> : payments.length===0?<p className="small">No payments yet.</p>:
          <ul className="list">{payments.map((item)=><li className="payment-receipt" key={item.txHash+item.pocketId+item.kind}>
            <div className="receipt-top"><strong>{item.kind==="paid"?"Payment":"Skipped"} · Pocket <code>#{item.pocketId}</code></strong><span className="small">{item.timestamp===undefined?"Block "+item.blockNumber.toString():new Date(Number(item.timestamp)*1000).toLocaleString()}</span></div>
            <div className="receipt-line">
              {item.kind==="paid"?<><div><span>USDT spent</span><strong>{item.usdtSpent===undefined?"—":formatUnits(item.usdtSpent,usdtDecimals)+" USDT"}</strong></div><div><span>Amount out</span><strong>{item.amountOut===undefined?"—":formatUnits(item.amountOut,POCKET_CURRENCIES.find((x)=>x.address.toLowerCase()===item.payoutToken?.toLowerCase())?.decimals??18)+" "+(POCKET_CURRENCIES.find((x)=>x.address.toLowerCase()===item.payoutToken?.toLowerCase())?.symbol??"Token")}</strong></div><a className="receipt-link" href={"/r/"+item.pocketId+"/"+item.txHash}>Receipt ↗</a></>:<div><span>Reason</span><strong>{({1:"rate_below_floor",2:"over_cap",3:"no_quote",4:"session_expired"} as Record<number,string>)[item.reasonCode??0]??"unknown"}</strong></div>}
              <a className="receipt-link" href={CELOSCAN_TX+item.txHash} target="_blank" rel="noreferrer">Celoscan ↗</a>
            </div>
          </li>)}</ul>}
      </section>}

      <nav className="tabbar" aria-label="Pocket sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={"tab" + (tab === t.id ? " active" : "")} aria-current={tab === t.id ? "page" : undefined} onClick={() => { setTab(t.id); window.scrollTo({ top: 0 }); }}>
            <span className="tab-icon" aria-hidden="true">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}
