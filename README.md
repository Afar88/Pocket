# Pocket v2

Pocket lets a sender pay a receiver in the receiver's local stablecoin using USDT held in the sender's Altana wallet. A pocket can pay once, weekly, or monthly. Each payment is an atomic Altana session batch and its outcome is visible on Celo.

## What v2 does

- **Receiver chooses the currency.** The sender selects the receiver's payout token when creating or editing a pocket. USDT payouts transfer directly; other supported fiat corridors are quoted by Textile.
- **Once or recurring.** Repeat is Once, Weekly, or Monthly. A one-off pocket closes on its first successful payment and the registry refuses a second payment.
- **On-chain rules.** PocketRegistry stores the payout token, USDT amount, payout daily cap, optional minimum output rate, public note, and schedule. The registry holds no funds. Only the owner can edit rules; only the approved Altana wallet can mark or skip a due payment.
- **Rate guard.** A floor of zero disables the guard. Otherwise the registry independently checks the quoted output rate before it accepts a payment mark. A floor can be changed with `setMinRate` without changing other pocket settings.
- **Public evidence.** PocketPaid stores the last payment details and emits the output token, USDT spent, output amount, tx reference, timestamp, and next due time. PocketSkipped publishes a reason code. The app reads both event streams and each receiver receipt re-checks the Celo transaction when opened.

## Tags and the Altana relay

Pocket pays from the user's Altana smart wallet. Altana's relayer submits each on-chain transaction and pays the gas; the signer and authoriser is the user's own Altana wallet. The relayer is the outer transaction sender, not the account authorising the payment.

Every Pocket transaction carries the ERC-8021 attribution code `celo_35b1e46e453d` together with Altana's `altana` code. Agent payments also carry `pocket_agent_10132`, identifying Pocket's ERC-8004 agent.

With `@celo/attribution-tags` 0.7.0, `verifyTx` verifies the executed Altana relay intent and returns its codes plus the signing wallet as `sender`.

Example:

```ts
const result = await verifyTx({
  client,
  hash: "0x0019bcdbb6169ec3e32f7e7cca60cd18cccb745cbe98cfc20000921a5f22695d"
});

// {
//   codes: ["altana", "celo_35b1e46e453d"],
//   schemaId: 0,
//   sender: "0x3308329dc148d7ba1c49caff58fdf81dbdfcd048"
// }
```

## Supported Celo currencies

All addresses and decimals below are copied from [Textile's official Celo address book](https://docs.textilecredit.com/protocol/address-book.html) (chain ID 42220).

| Receiver currency | Token | Celo contract | Decimals |
| --- | --- | --- | ---: |
| US Dollar | USDT | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | 6 |
| Nigerian Naira | cNGN | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` | 6 |
| Argentine Peso | wARS | `0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D` | 18 |
| Brazilian Real | wBRL | `0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0` | 18 |
| Mexican Peso | wMXN | `0x337E7456B420bD3481e7FA61fA9850343d610d34` | 18 |
| Colombian Peso (wrapped) | wCOP | `0x8a1D45e102e886510e891d2Ec656a708991e2D76` | 18 |
| Colombian Peso | COPM | `0xC92E8Fc2947E32F2B574CCA9F2F12097A71d5606` | 18 |
| Indonesian Rupiah | IDRX | `0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22` | 2 |
| British Pound | VGBP | `0x7aE4265eCfc1F31bc0e112DfcFE3D78E01f4BB7f` | 18 |
| Swiss Franc | VCHF | `0xc5eBeA9984c485EC5D58cA5a2D376620d93aF871` | 18 |

MiniPay shows dollars only. The currency picker does not change the sender's balance denomination: the sender funds the pocket in USDT.

## How refusals work

A due payment is not sent when a guard fails:

| Reason | Meaning |
| --- | --- |
| `rate_below_floor` | Textile's quoted output is below the pocket's minimum rate |
| `over_cap` | The quote or payment exceeds its USDT or payout daily cap |
| `no_quote` | Textile has no firm quote for the requested corridor or amount |
| `session_expired` | The pocket's approved Altana session has expired |

The agent records at most one skip event for a due period. A skip does not advance the schedule; later runs can retry that same due payment. Pocket payment permission ends one hour before the Altana key's own expiry. During that final hour the still-valid Altana key can publish the agent-only `session_expired` skip, but cannot mark a payment. After the Altana key itself expires, the owner must grant a new session. A one-off closes only after a payment. Payment transfer and markPaid are in one Altana batch so a failed on-chain rule reverts the transfer too.

## Project layout

- `contracts/` — PocketRegistry and Foundry tests
- `packages/core/` — Celo addresses, currency list, ABIs, and session permissions
- `apps/agent/` — Textile RFQ client, Altana session runner, and ERC-8004 registration
- `apps/web/` — passkey wallet, pocket controls, activity, and receiver receipts
- `deploy/` — phone-friendly registry deployment page and compiled creation bytecode
- `docs/` — deployment guide and integration notes

## Build and tests

    npm install
    npm run build
    npm run test:agent
    forge test

Agent tests mock Textile quotes, Altana sessions, and transaction execution. These commands must not send Celo transactions.

## Mainnet safeguards

- Celo mainnet only (chain ID 42220).
- The session's USDT daily cap defaults to a maximum of 5 USDT; relay fees consume session allowance too.
- The session call allowlist only permits transfer on the selected payout tokens, USDT approve to Textile when conversion is needed, and PocketRegistry mark/skip methods.
- The Textile swap must go to one of two documented Celo contracts with its own selectors: the reactor (`execute`, `executeBatch`) or, for Operator Vault fills, the VaultOrderExecutor `0x01b006d5c687bde182aa36F542f1f014144742e2` (`fill`). The exact USDT approval goes to whichever of the two the swap calls. Quote expiry is checked again before execution and the one permitted 502 retry uses a fresh nonce/signature.
- Never commit signing keys, session private keys, or environment secrets. Do not deploy or pay from CI.
- Scheduled checks run about every 15 minutes. A late run still considers overdue pockets due.
