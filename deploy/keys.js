import nacl from "tweetnacl";
import { bytesToHex } from "viem";

const $ = (id) => document.getElementById(id);

// Same pair format as `npm run keygen` in @pocket/agent (nacl.box.keyPair → hex).
// Everything happens in this page; nothing is stored or sent anywhere.
$("make").addEventListener("click", () => {
  const keypair = nacl.box.keyPair();
  $("pub").textContent = bytesToHex(keypair.publicKey);
  $("priv").textContent = bytesToHex(keypair.secretKey);
  $("result").hidden = false;
  $("make").textContent = "Make another pair";
});

for (const [button, target] of [["copyPub", "pub"], ["copyPriv", "priv"]]) {
  $(button).addEventListener("click", () => {
    navigator.clipboard.writeText($(target).textContent).then(() => { $(button).textContent = "Copied"; });
  });
}
