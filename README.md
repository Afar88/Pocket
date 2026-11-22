# Pocket

Pay the people you care for in naira, from one dollar wallet, within limits you set.

Pocket is an agent on **Celo mainnet**. You keep USD₮ in your own wallet and set up pockets for the people you support: a birthday gift, a weekly allowance, monthly family upkeep. On the right day, the agent converts USD₮ to **cNGN** on Textile FX and sends it to that person's own wallet.

## How it works

1. **Your wallet, your money.** You sign in with a passkey and get a self-custody Altana wallet. You fund it with USD₮.
2. **You set the limits.** You give the agent a session key with a spend cap, a short list of contracts it may call, and an expiry. Altana enforces these onchain, and you can revoke the key in one transaction.
3. **You create pockets.** Each pocket has a person, an amount, and a day. Pocket rules are stored onchain in a small registry contract. No database.
4. **The agent pays.** When a pocket is due, the agent gets a Textile FX quote, swaps USD₮ to cNGN, and sends it to the recipient.
5. **You see everything.** Every swap and payment links to Celoscan.

## Built with

- Celo mainnet
- Altana agent wallets and session keys
- Textile FX (USD₮ to cNGN)
- ERC-8004 agent identity
- ERC-8021 attribution tags
- Next.js, TypeScript, viem

## Hackathon

Built for Celo's **Agents Open for Business** hackathon, tracks: Stablecoin Corridors (Textile FX) and Altana Agent Wallets. Code written from 20 November 2026.

## Status

Early build. Real money on mainnet. Start with small amounts.
