# Pocket

Pay the people you care for in naira, from one dollar wallet, within limits you set.

Pocket is an agent on **Celo mainnet**. You keep USD₮ in your own Altana wallet and set up pockets for the people you support: a birthday gift, a weekly allowance, or monthly family upkeep. When a pocket is due, the agent requests a Textile FX quote, converts USD₮ to **cNGN**, and pays the recipient's wallet.

## How it works

1. **Your wallet, your money.** Sign in with a passkey and create or recover a self-custody Altana wallet.
2. **You set the limits.** Grant the agent a session key with a spend cap, contract and method allowlist, and an expiry. Altana enforces it, and you can revoke it.
3. **You create pockets.** Each pocket has a recipient, amount, interval, and first due date. PocketRegistry stores rules only and holds no funds.
4. **The agent pays.** It checks the due date and session, requests a Textile FX v2 quote, then runs the swap, cNGN transfer, and registry update through an Altana session.
5. **You see everything.** Confirmed swap/payment logs link to Celoscan.

## Project layout

- contracts/ — PocketRegistry and Foundry tests
- packages/core/ — chain addresses, ABIs, and shared session permissions
- apps/agent/ — TypeScript worker, Textile v2 RFQ client, Altana session runner, ERC-8004 registration script
- apps/web/ — Next.js passkey wallet, pocket controls, balance and payment history
- docs/ — deployment guide and integration open questions

## Build and test

    npm install
    npm run build
    npm run test:agent
    forge test

Agent tests use mocked quote, session, and execute dependencies. No Celo transactions are sent by these commands.

## Deploy

Read docs/DEPLOYMENT.md before deploying the registry, setting Render secrets, or enabling a worker. Integration questions and live-test gates are listed in docs/OPEN_QUESTIONS.md.

## Mainnet safety

- Celo mainnet only (chain ID 42220).
- The default maximum session USDt spend cap is **5 USDt per day**.
- ATTRIBUTION_TAG is required; an empty tag blocks transactions.
- No private key, seed phrase, or .env file belongs in this repository.
- No mainnet contract deployment, agent registration, approval, swap, or payment is performed by CI.

## Hackathon

Built for Celo's **Agents Open for Business** hackathon, tracks: Stablecoin Corridors (Textile FX) and Altana Agent Wallets. Submission deadline supplied for this project: **Monday, 7 December 2026, 09:00 GMT**.
