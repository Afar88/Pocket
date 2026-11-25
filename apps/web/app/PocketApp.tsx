"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createClient,
  serializeSession,
  CELO,
  signerFromPrivateKey
} from "@altananetwork/sdk";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  http,
  isAddress,
  parseUnits,
  zeroHash,
  type Address,
  type Hex
} from "viem";
import { celo } from "viem/chains";
import { verifyTx } from "@celo/attribution-tags";
import { generatePrivateKey } from "viem/accounts";
import {
  buildPocketSessionPolicy,
  CELO_CHAIN_ID,
  CELOSCAN_TX,
  CELO_RPC_DEFAULT,
  CELO_USDT,
  CNGN,
  ERC20_ABI,
  POCKET_CREATED_EVENT,
  POCKET_PAID_EVENT,
  POCKET_REGISTRY_ABI,
  sealToAgent,
  TEXTILE_REACTOR
} from "@pocket/core";

type AppConfig = {
  chainId: number;
  rpcUrl: string;
  registryAddress: string;
  attributionTag: string;
  agentEncPublicKey: string;
};
type PocketView = {
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
type SessionMeta = {
  publicKey: Hex;
  keyId: Hex;
  expiry: number;
  usdtDailyCap: string;
  cngnDailyCap: string;
  encryptedSessionKey: Hex;
  serializedSession: string;
};
type PaymentRow = { pocketId: string; txHash: Hex; blockNumber: bigint; usdtPaid?: string; cngnReceived?: string; recipient?: Address; attributionPresent?: boolean };
type ProgressStep = { label: string; state: "pending" | "active" | "done" | "stopped" };

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const POCKET_EVENTS_ABI = [POCKET_CREATED_EVENT] as const;
const TRANSFER_EVENT_ABI = [{ type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] }] as const;
function shortAddress(value: string): string { return value.length > 12 ? value.slice(0, 6) + "…" + value.slice(-4) : value; }
const sessionStorageKey = (walletAddress: string) =>
  "pocket-session-" + walletAddress.toLowerCase();
const PERIODS = [
  { label: "Every day", value: "86400" },
  { label: "Every week", value: "604800" },
  { label: "Every 30 days", value: "2592000" }
];

export default function PocketApp() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [sdk, setSdk] = useState<any>(null);
  const [wallet, setWallet] = useState<any>(null);
  const [usdtBalance, setUsdtBalance] = useState("—");
  const [usdtDecimals, setUsdtDecimals] = useState(6);
  const [cngnDecimals, setCngnDecimals] = useState(18);
  const [pockets, setPockets] = useState<PocketView[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ title: string; steps: ProgressStep[] } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1");
  const [label, setLabel] = useState("Weekly support");
  const [period, setPeriod] = useState("604800");
  const [firstDue, setFirstDue] = useState(new Date(Date.now() + 60_000).toISOString().slice(0, 16));

  const [usdtCap, setUsdtCap] = useState("5");
  const [cngnCap, setCngnCap] = useState("");
  const [expiryDays, setExpiryDays] = useState("30");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRecipient, setEditRecipient] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editPeriod, setEditPeriod] = useState("604800");
  const [editDue, setEditDue] = useState("");

  const publicClient = useMemo(() => createPublicClient({
    chain: celo,
    transport: http(config?.rpcUrl || CELO_RPC_DEFAULT)
  }), [config?.rpcUrl]);

  const registryAddress = config?.registryAddress as Address | undefined;
  const readyForWrites = Boolean(
    config?.registryAddress &&
    config?.attributionTag &&
    /^[a-z0-9_]{1,32}$/.test(config.attributionTag)
  );

  useEffect(() => {
    fetch("/api/config")
      .then((response) => response.json())
      .then((data: AppConfig) => setConfig(data))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const beginProgress = (title: string, labels: string[]) => setProgress({ title, steps: labels.map((label, index) => ({ label, state: index === 0 ? "active" : "pending" })) });
  const advanceProgress = (index: number) => setProgress((current) => current ? ({ ...current, steps: current.steps.map((step, i) => ({ ...step, state: i < index ? "done" : i === index ? "active" : "pending" })) }) : current);
  const finishProgress = () => setProgress((current) => current ? { ...current, steps: current.steps.map((step) => ({ ...step, state: "done" })) } : current);
  const stopProgress = () => setProgress((current) => current ? { ...current, steps: current.steps.map((step) => step.state === "active" ? { ...step, state: "stopped" } : step) } : current);

  const requireWriteSetup = useCallback(() => {
    if (!readyForWrites) {
      throw new Error("Set ATTRIBUTION_TAG and REGISTRY_ADDRESS in the Pocket web service before using wallet actions.");
    }
    if (!sdk || !wallet) throw new Error("Sign in with your passkey wallet first.");
    return { client: sdk, activeWallet: wallet, registry: registryAddress as Address };
  }, [readyForWrites, sdk, wallet, registryAddress]);

  const sendOwnerCalls = useCallback(async (calls: readonly { to: Address; data: Hex; value: bigint }[]) => {
    const { client, activeWallet } = requireWriteSetup();
    const result = await client.execute({
      wallet: activeWallet,
      signer: activeWallet.signer,
      calls: [...calls]
    });
    if (result.status !== "CONFIRMED" || !result.transactionHash) {
      throw new Error("Altana wallet action did not confirm: " + result.status);
    }
    setMessage("Confirmed: " + CELOSCAN_TX + result.transactionHash);
    return result.transactionHash as Hex;
  }, [requireWriteSetup]);

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
  }, [wallet, registryAddress, publicClient, config?.attributionTag]);

  const refresh = useCallback(async () => {
    if (!wallet || !registryAddress) return;
    try {
      const [balance, tokenDecimals, cngnTokenDecimals, count, latest] = await Promise.all([
        publicClient.readContract({
          address: CELO_USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address]
        }),
        publicClient.readContract({ address: CELO_USDT, abi: ERC20_ABI, functionName: "decimals" }),
        publicClient.readContract({ address: CNGN, abi: ERC20_ABI, functionName: "decimals" }),
        publicClient.readContract({ address: registryAddress, abi: POCKET_REGISTRY_ABI, functionName: "pocketCount" }),
        publicClient.getBlockNumber()
      ]);
      setUsdtDecimals(Number(tokenDecimals));
      setCngnDecimals(Number(cngnTokenDecimals));
      setUsdtBalance(formatUnits(balance, Number(tokenDecimals)));

      const own: PocketView[] = [];
      const start = count > 100n ? count - 99n : 1n;
      for (let id = start; id <= count; id += 1n) {
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
      setPockets(own.reverse());

      const fromBlock = latest > 50_000n ? latest - 50_000n : 0n;
      const logs = await publicClient.getLogs({
        address: registryAddress,
        event: POCKET_PAID_EVENT,
        fromBlock,
        toBlock: latest
      });
      const ownIds = new Set(own.map((p) => p.id.toString()));
      const rows = logs
        .filter((entry) => ownIds.has(String(entry.args.pocketId)))
        .map((entry) => ({ pocketId: String(entry.args.pocketId), txHash: entry.transactionHash as Hex, blockNumber: entry.blockNumber }))
        .reverse().slice(0, 20);
      const receiptRows = await Promise.all(rows.map(async (row): Promise<PaymentRow> => {
        let usdtPaid: string | undefined, cngnReceived: string | undefined, recipient: Address | undefined, attributionPresent: boolean | undefined;
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash: row.txHash });
          for (const log of receipt.logs) {
            const token = log.address.toLowerCase();
            if (token !== CELO_USDT.toLowerCase() && token !== CNGN.toLowerCase()) continue;
            try {
              const transfer = decodeEventLog({ abi: TRANSFER_EVENT_ABI, data: log.data, topics: log.topics });
              const from = transfer.args.from.toLowerCase(), to = transfer.args.to.toLowerCase();
              if (token === CELO_USDT.toLowerCase() && from === wallet.address.toLowerCase() && to === TEXTILE_REACTOR.toLowerCase() && transfer.args.value > 0n) usdtPaid = formatUnits(transfer.args.value, Number(tokenDecimals));
              if (token === CNGN.toLowerCase() && from === wallet.address.toLowerCase() && to !== wallet.address.toLowerCase() && transfer.args.value > 0n) { cngnReceived = formatUnits(transfer.args.value, Number(cngnTokenDecimals)); recipient = transfer.args.to; }
            } catch { /* Ignore non-ERC20 receipt logs. */ }
          }
        } catch { /* Keep the Celo receipt link if data is temporarily unavailable. */ }
        if (config?.attributionTag) {
          try {
            const result = await verifyTx({ client: publicClient as unknown as Parameters<typeof verifyTx>[0]["client"], hash: row.txHash });
            if (result && Array.isArray(result.codes)) attributionPresent = result.codes.includes(config.attributionTag);
          } catch { /* Hide attribution when verification is unavailable. */ }
        }
        return { ...row, ...(usdtPaid !== undefined ? { usdtPaid } : {}), ...(cngnReceived !== undefined ? { cngnReceived } : {}), ...(recipient !== undefined ? { recipient } : {}), ...(attributionPresent !== undefined ? { attributionPresent } : {}) };
      }));
      setPayments(receiptRows);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [wallet, registryAddress, publicClient]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function createWallet(recover: boolean) {
    setBusy(true);
    setError("");
    beginProgress(recover ? "Passkey sign-in" : "Create passkey wallet", [recover ? "Connecting passkey wallet" : "Creating passkey wallet"]);
    try {
      if (!config?.attributionTag) throw new Error("ATTRIBUTION_TAG must be configured before creating or changing wallets.");
      const client = createClient({ chains: [CELO], appCode: config.attributionTag });
      const rpId = window.location.hostname;
      const result = recover
        ? await client.recoverFromPasskey({ rpId })
        : await client.createPasskeyWallet({ name: "Pocket", rpId });
      setSdk(client);
      setWallet(result);
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
      finishProgress();
      setMessage("Passkey wallet ready: " + result.address);
    } catch (reason) {
      stopProgress();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createPocket() {
    setBusy(true); setError(""); setMessage("");
    try {
      const { registry } = requireWriteSetup();
      if (!isAddress(recipient)) throw new Error("Enter a valid Celo recipient wallet address.");
      if (!label.trim()) throw new Error("Add a name for this pocket.");
      const amountRaw = parseUnits(amount, usdtDecimals);
      const due = BigInt(Math.floor(new Date(firstDue).getTime() / 1000));
      if (amountRaw <= 0n || due <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("Amount and due date must be in the future.");
      if (amountRaw > parseUnits("5", usdtDecimals)) throw new Error("Keep each default pocket at or below 5 USDt.");
      const attachSession = Boolean(sessionMeta?.encryptedSessionKey && sessionMeta.serializedSession && sessionMeta.expiry > Math.floor(Date.now() / 1000));
      beginProgress("Create pocket", ["Saving pocket to Celo", "Confirming pocket receipt", ...(attachSession ? ["Attaching session to pocket"] : [])]);
      const createHash = await sendOwnerCalls([{
        to: registry,
        data: encodeFunctionData({
          abi: POCKET_REGISTRY_ABI,
          functionName: "createPocket",
          args: [recipient as Address, amountRaw, BigInt(period), due, label.trim()]
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
              BigInt(sessionMeta.expiry),
              BigInt(sessionMeta.usdtDailyCap),
              BigInt(sessionMeta.cngnDailyCap),
              sessionMeta.encryptedSessionKey,
              sessionMeta.serializedSession
            ]
          }),
          value: 0n
        }]);
      }
      setRecipient(""); setAmount("1"); setLabel("Weekly support");
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
    setEditDue(new Date(Number(p.nextDue) * 1000).toISOString().slice(0, 16));
  }

  async function saveEdit(id: bigint) {
    setBusy(true); setError("");
    try {
      const { registry } = requireWriteSetup();
      if (!isAddress(editRecipient)) throw new Error("Enter a valid recipient address.");
      const due = BigInt(Math.floor(new Date(editDue).getTime() / 1000));
      await sendOwnerCalls([{
        to: registry,
        data: encodeFunctionData({
          abi: POCKET_REGISTRY_ABI,
          functionName: "updatePocket",
          args: [id, editRecipient as Address, parseUnits(editAmount, usdtDecimals), BigInt(editPeriod), due, editLabel.trim()]
        }),
        value: 0n
      }]);
      setEditingId(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
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

  async function grantSession() {
    setBusy(true); setError("");
    try {
      const { client, activeWallet, registry } = requireWriteSetup();
      const ownPockets = await listOwnPockets();
      if (!ownPockets.some((p) => !p.deleted)) throw new Error("Create at least one pocket before granting the agent.");
      const secret = generatePrivateKey();
      const sessionSigner = signerFromPrivateKey(secret);
      const expiry = Math.floor(Date.now() / 1000) + Number(expiryDays) * 86_400;
      const usdtLimit = parseUnits(usdtCap, usdtDecimals);
      const cngnLimit = parseUnits(cngnCap, cngnDecimals);
      if (usdtLimit <= 0n || usdtLimit > parseUnits("5", usdtDecimals)) throw new Error("The USDt daily cap must be above zero and no more than 5.");
      if (cngnLimit <= 0n) throw new Error("Set a positive cNGN daily cap.");
      const permissions = buildPocketSessionPolicy({
        registryAddress: registry,
        usdtDailyCap: usdtLimit,
        cngnDailyCap: cngnLimit
      });
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
        cngnDailyCap: cngnLimit.toString(),
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
      const checkerApproval = await client.approveSignatureChecker({
        wallet: activeWallet,
        signer: activeWallet.signer,
        session,
        checker: TEXTILE_REACTOR,
        chainId: CELO_CHAIN_ID
      });
      if (checkerApproval.status !== "CONFIRMED") {
        throw new Error("Textile reactor signature-checker approval did not confirm: " + checkerApproval.status);
      }

      advanceProgress(2);
      const calls = ownPockets.filter((p) => !p.deleted).map((p) => ({
        to: registry,
        data: encodeFunctionData({
          abi: POCKET_REGISTRY_ABI,
          functionName: "approveAgent",
          args: [p.id, activeWallet.address as Address, session.keyId, BigInt(expiry), usdtLimit, cngnLimit, encryptedSessionKey, serializedSession]
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
      const { client, activeWallet, registry } = requireWriteSetup();
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
  const periodText = (seconds: bigint) => seconds === 86_400n ? "Every day" : seconds === 604_800n ? "Every week" : seconds === 2_592_000n ? "Every 30 days" : "Every " + (Number(seconds) / 86_400) + " days";
  const pocketStatus = (p: PocketView) => p.paused ? "Paused" : p.sessionExpiry > 0n && p.sessionExpiry <= BigInt(Math.floor(Date.now() / 1000)) ? "Session expired" : p.agent === ZERO ? "Session not granted" : "Active";
  const sessionIsExpired = Boolean(sessionMeta && sessionMeta.expiry <= Math.floor(Date.now() / 1000));

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
        <span className="pill">Chain {CELO_CHAIN_ID}</span>
      </header>

      {!config?.registryAddress && (
        <div className="notice">PocketRegistry is not set yet. Deploy the contract on Celo mainnet, then add REGISTRY_ADDRESS to both Render services.</div>
      )}
      {!config?.attributionTag && (
        <div className="notice">ATTRIBUTION_TAG is empty. Wallet actions and agent payments stay blocked until you add your Celo attribution code.</div>
      )}
      {config && !config.agentEncPublicKey && (
        <div className="notice">AGENT_ENC_PUBLIC_KEY is not set. Session grants are disabled until the agent encryption public key is configured.</div>
      )}
      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}
      {progress && <section className="panel progress-panel" aria-live="polite"><div className="progress-heading"><h2>{progress.title}</h2><span className="progress-state">{progress.steps.every((s) => s.state === "done") ? "Done" : progress.steps.some((s) => s.state === "stopped") ? "Stopped" : "In progress"}</span></div><ol className="progress-list">{progress.steps.map((step, index) => <li className={"progress-step " + step.state} key={step.label}><span className="step-index">{step.state === "done" ? "✓" : String(index + 1).padStart(2, "0")}</span><span>{step.label}</span><span className="step-state">{step.state === "active" ? "Working" : step.state === "done" ? "Done" : step.state === "stopped" ? "Stopped" : ""}</span></li>)}</ol></section>}

      <section className="panel sample-panel"><div className="sample-heading"><span className="sample-label">Sample</span><span className="small">Illustration only · no live payment</span></div><h2>One pocket, one payout</h2><p className="small">A calm walkthrough of what happens when a scheduled pocket is due.</p><div className="sample-flow"><div className="sample-step"><span className="sample-dot">01</span><div><strong>Pocket is due</strong><span>The schedule reaches its next payout time.</span></div></div><div className="sample-step"><span className="sample-dot">02</span><div><strong>Textile swaps USDT to cNGN</strong><span>The wallet stays in control through its limited session.</span></div></div><div className="sample-step"><span className="sample-dot">03</span><div><strong>Recipient gets cNGN</strong><span>The confirmed payout is recorded on Celo.</span></div></div></div></section>

      <section className="panel hero">
        <div>
          <p className="small">USDt in your Altana wallet</p>
          <div className="balance">{usdtBalance === "—" ? "—" : usdtBalance + " USDt"}</div>
          <p className="sub">Funds stay in your wallet until a pocket is due.</p>
          {wallet && <p className="meta">Wallet: {wallet.address}</p>}
        </div>
        <div className="actions">
          <button disabled={busy || !config?.attributionTag} onClick={() => void createWallet(false)}>Create passkey wallet</button>
          <button className="secondary" disabled={busy || !config?.attributionTag} onClick={() => void createWallet(true)}>Sign in</button>
          {wallet && <button className="secondary" disabled={busy} onClick={() => void refresh()}>Refresh</button>}
        </div>
      </section>

      <div className="grid">
        <section className="panel form-panel">
          <h2>New pocket</h2>
          <p className="small">Set who gets paid, how much, and how often.</p>
          <label>Name</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} placeholder="Family upkeep" />
          <label>Recipient wallet</label>
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x..." />
          <div className="row">
            <div><label>USDt amount</label><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></div>
            <div><label>Repeat</label><select value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></div>
          </div>
          <label>First payment date and time</label>
          <input type="datetime-local" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
          <div className="notice">USDt pockets are capped at 5 per payment by default. Textile FX mainnet quotes have a $1 minimum. Keep the payment below your session cap so there is room for relay fees.</div>
          <button disabled={busy || !wallet || !readyForWrites} onClick={() => void createPocket()}>Create pocket</button>
        </section>

        <section className="panel session-panel">
          <div className="section-heading"><div><h2>Session key</h2><p className="small">A limited key for the Pocket agent.</p></div>{sessionMeta && <span className={"status-pill " + (sessionIsExpired ? "expired" : "active")}>{sessionIsExpired ? "Expired" : "Active"}</span>}</div>
          {sessionMeta ? <div className="session-summary"><div className="limit-grid"><div className="limit-tile"><span>Daily USDT cap</span><strong className="mono">{formatUnits(BigInt(sessionMeta.usdtDailyCap), usdtDecimals)} USDT</strong></div><div className="limit-tile"><span>Daily cNGN cap</span><strong className="mono">{formatUnits(BigInt(sessionMeta.cngnDailyCap), cngnDecimals)} cNGN</strong></div></div><div className="session-detail"><span>Expiry</span><strong>{new Date(sessionMeta.expiry * 1000).toLocaleString()}</strong></div><div className="session-detail"><span>Key ID</span><code>{shortAddress(sessionMeta.keyId)}</code></div><div className="contract-list"><span className="contract-heading">Allowed contracts</span><div className="contract-item"><span>Textile reactor · execute and signature check</span><code>{shortAddress(TEXTILE_REACTOR)}</code></div><div className="contract-item"><span>USDT · approve</span><code>{shortAddress(CELO_USDT)}</code></div><div className="contract-item"><span>cNGN · transfer</span><code>{shortAddress(CNGN)}</code></div><div className="contract-item"><span>PocketRegistry · payment records</span><code>{config?.registryAddress ? shortAddress(config.registryAddress) : "Unavailable"}</code></div></div><p className="small">Limits are enforced by the Altana session. USDT headroom includes relay fees. Revoke the key to stop the agent.</p><button className="danger revoke-button" disabled={busy || !wallet || !readyForWrites} onClick={() => void revokeSession()}>Revoke key</button></div> : <><p className="small">Set the limits before granting the agent access. You can revoke the key later.</p><div className="row">
            <div><label>USDt daily cap (max 5)</label><input value={usdtCap} onChange={(e) => setUsdtCap(e.target.value)} inputMode="decimal" /></div>
            <div><label>cNGN daily cap</label><input value={cngnCap} onChange={(e) => setCngnCap(e.target.value)} inputMode="decimal" placeholder="Set limit" /></div>
          </div>
          <label>Key expires in days</label>
          <select value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)}>
            <option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
          </select>
          <div className="notice">
            Allowed calls are method-limited: Textile order execution, USDt approval, cNGN transfer, and PocketRegistry swap/payment records. Pocket also asks Altana to let the Textile reactor verify this session's ERC-1271 signatures. Owner-only PocketRegistry actions are not allowed. The USDt cap includes Altana relay fees. The session key is encrypted to the agent and is never shown or stored here.
          </div>
          <p className="meta">FX: {TEXTILE_REACTOR}<br />USDt: {CELO_USDT}<br />cNGN: {CNGN}<br />Registry: {config?.registryAddress || "Not deployed"}</p>
              <button disabled={busy || !wallet || !readyForWrites || pockets.length === 0} onClick={() => void grantSession()}>Grant session key</button>
            </>
          )}
        </section>
      </div>

      <section className="panel pockets-panel"><div className="section-heading"><div><h2>Your pockets</h2><p className="small">Rules are on Celo. Funds stay in your wallet until payout.</p></div>{wallet && <span className="count-pill">{pockets.filter((p) => !p.deleted).length} pockets</span>}</div>
        {!wallet && <p>Sign in with your passkey to see your pockets.</p>}
        {wallet && pockets.length === 0 && <p>No pockets yet.</p>}
        {pockets.filter((p) => !p.deleted).map((p) => (
          <div className="pocket-card" key={p.id.toString()}>
            <div className="pocket-top"><div className="pocket-title"><span className="eyebrow">POCKET <code>#{p.id.toString()}</code></span><h3>{p.label}</h3></div><span className={"status-pill " + (pocketStatus(p) === "Paused" ? "paused" : pocketStatus(p) === "Active" ? "active" : "expired")}>{pocketStatus(p)}</span></div>
            <div className="pocket-amount"><span>Paid each cycle</span><strong className="mono">{formatUnits(p.amountUsdt, usdtDecimals)} USDT</strong></div>
            <div className="pocket-facts"><div><span>Recipient</span><code>{shortAddress(p.recipient)}</code></div><div><span>Frequency</span><strong>{periodText(p.period)}</strong></div><div><span>Next payout</span><strong>{dateText(p.nextDue)}</strong></div></div>
            {editingId === p.id.toString() ? (
              <div>
                <label>Name</label><input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} />
                <label>Recipient</label><input value={editRecipient} onChange={(e) => setEditRecipient(e.target.value)} />
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
                <button className="secondary" disabled={busy || !readyForWrites} onClick={() => void setPaused(p, !p.paused)}>{p.paused ? "Resume" : "Pause"}</button>
                <button className="danger" disabled={busy || !readyForWrites} onClick={() => void deletePocket(p)}>Delete</button>
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="panel how-panel"><h2>How it works</h2><div className="how-strip"><div className="how-step"><span>01</span><strong>Your wallet</strong><small>Funds stay with you</small></div><div className="how-arrow">→</div><div className="how-step"><span>02</span><strong>Altana session key</strong><small>With daily limits</small></div><div className="how-arrow">→</div><div className="how-step"><span>03</span><strong>Pocket agent</strong><small>ERC-8004 #10132</small></div><div className="how-arrow">→</div><div className="how-step"><span>04</span><strong>Textile FX swap</strong><small>USDT to cNGN</small></div><div className="how-arrow">→</div><div className="how-step"><span>05</span><strong>Recipient</strong><small>Gets cNGN</small></div></div></section>

      <section className="panel payments-panel">
        <h2>Payments</h2>
        <p className="small">Recent confirmed payments from PocketRegistry events. Explorer links use the transaction receipt, not a stored quote ID.</p>
        {payments.length === 0 ? <p>No confirmed payments found in the last 50,000 blocks.</p> : (
          <ul className="list">
            {payments.map((payment) => (
              <li className="payment-receipt" key={payment.txHash + payment.pocketId}><div className="receipt-top"><strong>Pocket <code>#{payment.pocketId}</code></strong><span className="small">Block <code>{payment.blockNumber.toString()}</code></span></div><div className="receipt-line">
                {payment.usdtPaid !== undefined && <div><span>USDT paid</span><strong className="mono">{payment.usdtPaid} USDT</strong></div>}
                {payment.cngnReceived !== undefined && <div><span>cNGN received</span><strong className="mono">{payment.cngnReceived} cNGN</strong></div>}
                {payment.recipient !== undefined && <div><span>Recipient</span><code>{shortAddress(payment.recipient)}</code></div>}
                {typeof payment.attributionPresent === "boolean" && <div><span>Attribution tag</span><strong>Present · {payment.attributionPresent ? "Yes" : "No"}</strong></div>}
                <a className="receipt-link" href={CELOSCAN_TX + payment.txHash} target="_blank" rel="noreferrer">Celo tx ↗</a></div></li>
            ))}
          </ul>
        )}
      </section>
      <p className="small">Pocket is an early mainnet build. Check your caps, session expiry, recipient address, and quote before relying on a scheduled payment.</p>
    </main>
  );
}
