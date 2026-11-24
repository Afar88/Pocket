# Open questions and live integration gates

These are not claims that a production flow has been verified. Resolve them before enabling an unattended mainnet worker.

## 1. Textile TakerControl proof for an Altana wallet

Textile v2 keyless RFQ asks for a TakerControl EIP-712 proof, with the RFQ taker set to the Altana smart-wallet address. The current agent signs that proof with the session-key EOA from AGENT_PRIVATE_KEY. Textile's documented Celo quote schema and request route are implemented, but no real RFQ has confirmed that this delegated EOA proof is accepted for the Altana smart-wallet taker (including any ERC-1271/contract-wallet proof handling).

**Required check:** request a small firm quote on Celo mainnet and confirm Textile accepts the proof with the exact Altana wallet + session key. Do not swap funds to test this step.

## 2. Attribution: viem extension and Altana session relay

The agent creates one viem wallet client and applies withAttribution(ATTRIBUTION_TAG) from @celo/attribution-tags. Altana session transactions, however, must be submitted with client.execute({ session, calls }); sending those calls directly from the viem EOA would bypass the user's smart-wallet session and spend policy.

Altana documents createClient({ chains: [CELO], appCode: ATTRIBUTION_TAG }) as the way to tag its own relayed execute transactions. The worker uses this documented hook for every Altana session execution, while the tagged viem wallet client signs Textile's EIP-712 proof. The standalone ERC-8004 script uses a tagged viem wallet client for its one registration transaction.

**Required check:** verify a real Altana session transaction with verifyTx and confirm the supplied tag appears. The literal requirement that every Altana-relayed transaction be sent through the same viem wallet client is not implementable without bypassing Altana's session-execution path; do not remove the session path to satisfy that wording.

## 3. Textile reactor selector

The shared Altana policy allows only the reactor's execute((bytes,bytes)) and executeBatch((bytes,bytes)[]) entry points. This matches the documented UniswapX reactor model used by the integration, but the exact selector returned in the first Celo firm quote has not been inspected on a live RFQ.

**Required check:** inspect the selector in transactions.swap.data before a live payment. If Textile returns a different selector, verify its ABI and purpose before adding it to the allowlist. Do not broaden the reactor permission to arbitrary contracts.

## 4. ERC-8004 identity owner

The registration script sends register(string) from AGENT_PRIVATE_KEY; therefore the registered identity owner is the session-key EOA. The product's main account is the user's Altana smart wallet.

**Decision needed:** confirm whether the ERC-8004 identity should be owned by the session-key EOA or the Altana smart wallet. If it should be the smart wallet, registration should be initiated through an owner-authorized Altana execution and the session policy reviewed for that one-off call.

## 5. Key ID and session reconstruction

The worker derives the session key ID from the EOA's SEC1 public key and compares it with the ID stored in PocketRegistry before constructing the Altana session. This follows Altana's documented v0 key ID convention (keccak256(publicKey)). It also checks isValidKey(user, keyId) on the Celo Keystore.

**Required check:** confirm this reconstruction against the exact installed SDK version and the first granted key, then verify that revoke is observed before the next poll.

## 6. Schedule model and missed periods

Pocket uses fixed-second periods: 1 day, 7 days, or 30 days. The contract advances nextDue by exactly one period per payment, even if a pocket is more than one period overdue. The UI queries recent PocketPaid events from the last 50,000 blocks; it is not a full event indexer.

**Decision needed:** decide whether missed periods should be paid one per worker cycle (current behavior), skipped, or caught up under a separate explicit rule. Calendar-month and historical payment pagination are not part of this MVP.

## 7. Current status

- No Textile live quote or swap has been run.
- No Altana relay/session execution has been run by this build.
- No ERC-8004 registration has been submitted.
- No PocketRegistry contract has been deployed.
- No Celo mainnet transaction has been sent.
- The UI, APIs, and SDK types have not been confirmed by a successful end-to-end build or wallet session.
