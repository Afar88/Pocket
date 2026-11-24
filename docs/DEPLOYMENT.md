# Deploy Pocket to Celo mainnet

This is a manual first-release guide. The repository does not deploy a registry automatically, and the agent is not safe to enable for real payments until the open questions are resolved and the first small payment has been supervised.

## 1. Local prerequisites

- Node.js 22 and npm
- Foundry (forge, cast)
- A Celo mainnet RPC
- A Celo attribution code assigned to you
- A passkey-capable browser
- An Altana wallet funded with a small amount of USDt

Install packages and build:

    npm install
    npm run build

Run the local tests:

    npm run test:agent
    forge test

The agent tests use injected mock quote, session-check, and execution dependencies. They do not connect to Textile, Altana relay, or Celo.

## 2. Deploy PocketRegistry on Celo mainnet

The contract has no constructor arguments and holds no funds. It stores payment instructions only.

Set a local shell variable for the deployment key. Do not put it in .env, source control, a command file, or a chat message.

    export CELO_RPC="https://forno.celo.org"
    export DEPLOYER_PRIVATE_KEY="0x..." # local shell only; never commit
    cast chain-id --rpc-url "$CELO_RPC"
    forge create contracts/src/PocketRegistry.sol:PocketRegistry \
      --rpc-url "$CELO_RPC" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      --broadcast

Confirm the RPC reports 42220, save the deployed address, and inspect the deployment transaction on https://celoscan.io. There is no registry address committed to this repository: every deployer gets a different address.

## 3. Configure Render

Create the two services from render.yaml (or create matching services manually):

- pocket-web: Next.js web service
- pocket-agent: long-running background worker; polls every two minutes

Set these values in Render's environment settings. The worker needs all four; the web service needs CELO_RPC, ATTRIBUTION_TAG, and REGISTRY_ADDRESS.

| Variable | Value |
| --- | --- |
| CELO_RPC | Celo mainnet RPC URL |
| ATTRIBUTION_TAG | Your lowercase Celo attribution code |
| REGISTRY_ADDRESS | The deployed PocketRegistry address |
| AGENT_PRIVATE_KEY | The session-key private key copied once from the Pocket UI |

Keep AGENT_PRIVATE_KEY as a Render secret on the worker only. Never add it to the web service, .env, the repo, or a build argument. If ATTRIBUTION_TAG is empty or invalid, the agent refuses to submit transactions.

## 4. Create and fund the wallet

1. Open the deployed Pocket site.
2. Choose Create passkey wallet. On a later visit choose Sign in to recover that same wallet.
3. Confirm the address shown in the app. It is the Altana smart wallet; it is not the agent session-key EOA.
4. Fund this wallet with only the USDt you intend to test and enough balance for Altana's relayer fees.
5. Refresh and confirm the USDt balance is visible.

Pocket is Celo mainnet only. Do not use Celo Sepolia or another testnet for hackathon scoring.

## 5. Create one small pocket and grant the session

1. Create one pocket for a recipient address you control.
2. Start with a small amount (for example, 1 USDt). Textile FX quotes currently require at least 1 USDt. Do not exceed 5 USDt.
3. Choose a suitable cNGN daily cap. Caps are in token base units and are enforced by the Altana session.
4. Grant the session. The session permissions restrict the reactor to order-execution calls, USDt to approve, cNGN to transfer, and PocketRegistry to recordSwap and markPaid.
5. Copy the one-time private key shown by the UI and save it directly in the Render worker's AGENT_PRIVATE_KEY secret. The UI does not save that private key in local storage.
6. Restart the worker after setting the secret.

The USDt session cap is hard-limited to 5 USDt per day in this MVP. Altana relay fees also consume the session's spend allowance, so leave headroom. The contract records the approved Altana smart-wallet address and session-key ID; the worker independently checks the session key's live Keystore status before quoting or paying.

## 6. Supervise the first live payment yourself

Do not enable unattended payments until you have checked the Textile and Altana open questions in OPEN_QUESTIONS.md.

For the first payment:

1. Confirm the worker sees exactly one due pocket.
2. Confirm the Textile RFQ is for Celo chain ID 42220, USDt to cNGN, the expected Altana smart-wallet taker, and the documented Textile reactor.
3. Confirm the firm quote amount, output, and expiry.
4. Watch for a separate USDt approval only if the current allowance is too low.
5. Verify the swap and cNGN payout transaction from the log's Celoscan link.
6. Check the attribution entry with verifyTx; the worker logs the returned codes and whether your tag was present.
7. Confirm the PocketSwap and PocketPaid events and that nextDue advanced by one period.
8. Revoke the session from the UI and confirm subsequent runs skip the pocket.

Do not treat the worker log as proof of payment by itself. Verify the transaction receipt, recipient cNGN balance, registry events, and session status onchain.

## 7. ERC-8004 registration (optional, separate transaction)

The command below is deliberately not run by the build or deployment workflow. It submits a real Celo mainnet transaction when you invoke it.

    npm run register:agent

The current script registers the AGENT_PRIVATE_KEY EOA as the ERC-8004 identity owner, not the user's Altana smart-wallet address. Check OPEN_QUESTIONS.md before running it if the identity should belong to the smart wallet instead.

## Safety notes

- No testnet transaction is counted for this project.
- Never use more than 5 USDt as the configured daily session cap.
- The Registry stores rules, not assets; the Altana wallet holds the funds.
- Pausing/deleting a pocket does not replace revoking a compromised session key.
- A lost session-key private key should be revoked from Altana immediately.
- All deployment, registration, approval, and payment transactions are user-operated. This repository's CI does not send them.
