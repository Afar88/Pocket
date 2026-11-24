# Open questions and live integration gates

These are not claims that a production flow has been verified. Resolve them before enabling an unattended mainnet worker.

## 1. Textile RFQ with Altana smart-wallet proof

Textile v2 RFQ asks for a TakerControl EIP-712 proof, with the RFQ taker set to the Altana smart-wallet address. The worker signs that typed data through Altana's documented signOrderTypedData({session, typedData}) API. That API wraps the session-key signature in the ERC-1271 envelope checked by the Altana smart account; it does not send an EOA signature from the delegated key as though it were the wallet.

**Required check:** make a small mainnet firm-quote request and confirm Textile accepts the Altana ERC-1271 signature for this taker. The quote request itself does not swap funds. No live request has been run by this PR.

## 2. Attribution: viem extension and Altana session relay

The worker constructs exactly one viem wallet client and extends it with withAttribution(ATTRIBUTION_TAG). Altana session transactions must still be submitted with client.execute({session, calls, chainId: 42220}); sending those calls directly from the viem EOA would bypass the user's smart-wallet session and spend policy.

Altana's documented createClient({chains: [CELO], appCode: ATTRIBUTION_TAG}) tags every Altana relay execution with the same app code. The viem client is not used to bypass that executor. The worker verifies the first confirmed transaction with verifyTx and logs whether the code is present.

**Required check:** verify a real Altana session transaction and confirm verifyTx reports the supplied app code. The literal demand that each Altana-relayed transaction be sent via the viem EOA wallet client cannot be followed without abandoning Altana's session enforcement; this implementation preserves the session path and the Altana attribution hook.

## 3. Textile reactor selector

The shared Altana policy allows only the reactor's execute((bytes,bytes)) and executeBatch((bytes,bytes)[]) entry points. This matches the documented UniswapX reactor model used by the integration, but the exact selector returned in the first Celo firm quote has not been inspected on a live RFQ.

**Required check:** inspect the selector in transactions.swap.data before a live payment. If Textile returns a different selector, verify its ABI and purpose before adding it to the allowlist. Do not broaden the reactor permission to arbitrary contracts.

## 4. ERC-8004 identity owner

The registration script sends register(string) from AGENT_PRIVATE_KEY; therefore the registered identity owner is the session-key EOA. The product's main account is the user's Altana smart wallet.

**Decision needed:** confirm whether the ERC-8004 identity should be owned by the session-key EOA or the Altana smart wallet. If it should be the smart wallet, registration should be initiated through an owner-authorized Altana execution and the session policy reviewed for that one-off call.

## 5. Key ID and session reconstruction

The worker derives the session key ID from the EOA's SEC1 public key and compares it with the ID stored in PocketRegistry before constructing the Altana session. This follows Altana's documented key ID convention (keccak256(publicKey)). It also checks isValidKey(user, keyId) on the Celo Keystore.

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
- CI has not yet completed a green build on the latest commit.
