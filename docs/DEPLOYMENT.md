# Deploy Pocket

Pocket uses a free Render web service for the user-facing app and GitHub Actions for scheduled agent runs. The registry deployment and any wallet funding or payment remain explicit operator actions; the hosting setup does not submit mainnet transactions.

## 1. Local prerequisites

- Node.js 22 and npm
- Foundry (forge, cast)
- A Celo RPC URL
- A Celo attribution code assigned to you
- A passkey-capable browser
- An Altana wallet funded with the USDt you intend to use

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

Confirm the RPC reports 42220, save the deployed address, and inspect the deployment transaction on https://celoscan.io. There is no registry address committed to this repository: every deployer gets a different address. This command is an operator-run deployment step; it is not run by CI or the hosting configuration.

## 3. Configure the Pocket web service on Render

Create the `pocket-web` web service from `render.yaml` on Render's **free** plan. The Blueprint contains no agent worker.

The free web service sleeps after 15 minutes without traffic. Its first request after sleeping can take about a minute while the service wakes.

Set these environment variables on `pocket-web`:

| Variable | Value |
| --- | --- |
| `CELO_RPC` | Celo RPC URL (the Blueprint supplies a public Celo RPC default) |
| `ATTRIBUTION_TAG` | Your lowercase Celo attribution code |
| `REGISTRY_ADDRESS` | The deployed PocketRegistry address |
| `AGENT_ENC_PUBLIC_KEY` | Public half of the agent encryption keypair; safe to expose to the web app |

The three values marked `sync: false` are entered in Render's environment settings. Never configure either agent private key on Render. In particular, `AGENT_PRIVATE_KEY` and `AGENT_ENC_PRIVATE_KEY` belong only in GitHub Actions repository secrets.

## 4. Configure the scheduled agent in GitHub Actions

The agent runs from `.github/workflows/agent.yml` after the multi-user workflow is merged. It is scheduled every 15 minutes and can also be started manually with **workflow_dispatch**. Workflow concurrency prevents overlapping runs.

In the repository's **Settings → Secrets and variables → Actions**, add these repository secrets:

| Secret | Purpose |
| --- | --- |
| `AGENT_PRIVATE_KEY` | The agent's single signing key |
| `AGENT_ENC_PRIVATE_KEY` | Private half of the agent encryption keypair |

Add these repository Actions variables:

| Variable | Value |
| --- | --- |
| `ATTRIBUTION_TAG` | Your lowercase Celo attribution code |
| `REGISTRY_ADDRESS` | The deployed PocketRegistry address |

Set the secrets yourself in GitHub repository settings. Do not commit them, put them in a workflow file, or send them in a pull request or chat message.

## 5. Generate the agent encryption keypair

Generate the keypair locally with:

    npm run keygen --workspace @pocket/agent

Copy the **public** half into Render as `AGENT_ENC_PUBLIC_KEY`. Store the **private** half in the GitHub Actions repository secret `AGENT_ENC_PRIVATE_KEY`. Keep the generated private half out of the repository, Render, build logs, pull requests, and chat.

The agent signing key is separately configured once as the GitHub Actions secret `AGENT_PRIVATE_KEY`. The web app only needs the agent's public encryption key. **Users never generate, copy, or paste a session private key.**

## 6. Create a wallet and grant the agent session

1. Open the deployed Pocket site. The first visit can take about a minute if the Render free service has been sleeping.
2. Choose **Create passkey wallet**. On a later visit choose **Sign in** to recover the same wallet.
3. Confirm the address shown in the app. It is the Altana smart wallet, not the agent signing-key address.
4. Fund the wallet with only the USDt you intend to use and enough balance for Altana's relayer fees.
5. Create a pocket for a recipient address you control.
6. In the Altana wallet, approve the agent's displayed public key as the session signer. Review the requested cap, contract/function allowlist, and expiry before approving.
7. Confirm the pocket is stored in PocketRegistry. Use the Pocket UI to revoke the session when it should no longer be active.

The web app uses the configured public encryption key to protect session material for the agent. Neither the agent signing private key nor the encryption private key is shown to users.

The USDt session cap is hard-limited to 5 USDt per day in this MVP. Altana relay fees also consume the session's spend allowance, so leave headroom. The agent independently checks the stored owner, session key ID, and live Keystore status before quoting or paying.

## 7. Supervise the first live payment yourself

Do not enable unattended payments until you have checked the Textile and Altana open questions in `OPEN_QUESTIONS.md`.

For the first payment:

1. Confirm the scheduled or manually triggered agent run sees the expected due pocket.
2. Confirm the Textile RFQ is for Celo chain ID 42220, USDt to cNGN, the expected Altana smart-wallet taker, and the documented Textile reactor.
3. Confirm the firm quote amount, output, and expiry.
4. Watch for a separate USDt approval only if the current allowance is too low.
5. Verify the swap and cNGN payout transaction from the run log's Celoscan link.
6. Check the attribution entry with verifyTx; the agent logs the returned codes and whether your tag was present.
7. Confirm the PocketSwap and PocketPaid events and that nextDue advanced by one period.
8. Revoke the session from the UI and confirm subsequent runs skip the pocket.

Do not treat an agent log as proof of payment by itself. Verify the transaction receipt, recipient cNGN balance, registry events, and session status onchain.

## 8. ERC-8004 registration (optional, separate transaction)

The command below is deliberately not run by the build or deployment workflow. It submits a real Celo mainnet transaction when you invoke it.

    npm run register:agent

The current script registers the `AGENT_PRIVATE_KEY` EOA as the ERC-8004 identity owner, not the user's Altana smart-wallet address. Check `OPEN_QUESTIONS.md` before running it if the identity should belong to the smart wallet instead.

## Safety notes

- Never use more than 5 USDt as the configured daily session cap.
- The Registry stores rules, not assets; the Altana wallet holds the funds.
- Pausing or deleting a pocket does not replace revoking a compromised session key.
- Revoke an affected session immediately if its session key is compromised.
- All registry deployment, wallet funding, session approval, registration, and payment transactions are explicit operator or user actions. CI and hosting setup do not submit them.
