import { createPublicClient, http, formatEther } from "viem";
import { celo } from "viem/chains";
import { toDataSuffix, verifyTx } from "@celo/attribution-tags";
import { ATTRIBUTION_TAG, CELO_CHAIN_ID, CELO_CHAIN_HEX, CELO_RPC, CELOSCAN } from "./config.js";

const $ = (id) => document.getElementById(id);
const ethereum = window.ethereum;
const publicClient = createPublicClient({ chain: celo, transport: http(CELO_RPC) });
let account = null;
let bytecode = "";

$("tag").textContent = ATTRIBUTION_TAG;

function setError(msg) { $("error").textContent = msg || ""; }

async function refreshBalance() {
  if (!account) { $("bal").textContent = "—"; return; }
  const balance = await publicClient.getBalance({ address: account });
  $("bal").textContent = Number(formatEther(balance)).toFixed(4) + " CELO";
}

async function updateChain() {
  const chainId = await ethereum.request({ method: "eth_chainId" });
  const onCelo = parseInt(chainId, 16) === CELO_CHAIN_ID;
  $("net").textContent = onCelo ? "Celo mainnet (42220)" : "Wrong network (" + parseInt(chainId, 16) + ")";
  $("switch").hidden = onCelo;
  $("deployCard").hidden = !onCelo || !account;
}

async function connect() {
  setError("");
  if (!ethereum) { setError("No injected wallet found. Open this page in the MetaMask mobile browser."); return; }
  try {
    const accounts = await ethereum.request({ method: "eth_requestAccounts" });
    account = accounts[0];
    $("addr").textContent = account.slice(0, 6) + "…" + account.slice(-4);
    await updateChain();
    await refreshBalance();
    $("connect").textContent = "Connected";
    $("connect").disabled = true;
  } catch (e) { setError(e.message || String(e)); }
}

async function switchChain() {
  setError("");
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CELO_CHAIN_HEX }] });
  } catch (e) {
    if (e.code === 4902) {
      await ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: CELO_CHAIN_HEX,
        chainName: "Celo",
        nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
        rpcUrls: [CELO_RPC],
        blockExplorerUrls: [CELOSCAN]
      }] });
    } else { setError(e.message || String(e)); return; }
  }
  await updateChain();
}

async function deploy() {
  setError("");
  $("deploy").disabled = true;
  $("deploy").textContent = "Confirm in your wallet…";
  try {
    // Re-read the authorized account: the wallet may have switched accounts
    // since connect, and the transaction must come from the current one.
    const accounts = await ethereum.request({ method: "eth_accounts" });
    account = accounts[0];
    if (!account) throw new Error("Wallet account disconnected. Connect again.");
    $("addr").textContent = account.slice(0, 6) + "…" + account.slice(-4);

    const suffix = toDataSuffix(ATTRIBUTION_TAG);
    const data = bytecode + suffix.slice(2);
    const hash = await ethereum.request({
      method: "eth_sendTransaction",
      params: [{ from: account, data }]
    });
    $("deploy").textContent = "Waiting for confirmation…";
    // If the wallet speeds up the transaction, the receipt belongs to the
    // replacement — link and verify that hash, not the superseded one.
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const confirmedHash = receipt.transactionHash;
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error("Deploy transaction did not confirm: " + confirmedHash);
    }
    $("contract").textContent = receipt.contractAddress;
    $("txlink").href = CELOSCAN + "/tx/" + confirmedHash;
    $("resultCard").hidden = false;
    $("tagStatus").textContent = "Checking ERC-8021 attribution…";
    const decoded = await verifyTx({ client: publicClient, hash: confirmedHash });
    const present = Boolean(decoded && decoded.codes.includes(ATTRIBUTION_TAG));
    $("tagStatus").textContent = present
      ? "Attribution confirmed onchain: " + ATTRIBUTION_TAG
      : "Deploy confirmed, but the attribution tag was not found on the transaction.";
    $("deploy").textContent = "Deployed";
  } catch (e) {
    setError(e.message || String(e));
    $("deploy").disabled = false;
    $("deploy").textContent = "Deploy to Celo mainnet";
  }
}

$("connect").addEventListener("click", connect);
$("switch").addEventListener("click", switchChain);
$("deploy").addEventListener("click", deploy);
$("copy").addEventListener("click", () => {
  navigator.clipboard.writeText($("contract").textContent).then(() => { $("copy").textContent = "Copied"; });
});
if (ethereum) {
  ethereum.on("chainChanged", () => { void updateChain().then(refreshBalance); });
  ethereum.on("accountsChanged", (accounts) => {
    account = accounts[0] ?? null;
    $("addr").textContent = account ? account.slice(0, 6) + "…" + account.slice(-4) : "—";
    if (!account) { $("connect").disabled = false; $("connect").textContent = "Connect wallet"; }
    void updateChain().then(refreshBalance);
  });
}

fetch("./registry.bytecode").then((r) => r.text()).then((t) => { bytecode = t.trim(); })
  .catch(() => setError("Could not load the PocketRegistry bytecode from this site."));
