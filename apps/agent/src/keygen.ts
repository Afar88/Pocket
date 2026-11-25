import { agentEncKeypair } from "@pocket/core";

// Prints the worker's X25519 encryption keypair once. Put the private half in
// the worker secrets (AGENT_ENC_PRIVATE_KEY) and the public half in the web
// service environment (AGENT_ENC_PUBLIC_KEY). Never commit either to the repo.
const keypair = agentEncKeypair();
console.info("AGENT_ENC_PUBLIC_KEY=" + keypair.publicKey);
console.info("AGENT_ENC_PRIVATE_KEY=" + keypair.privateKey);
