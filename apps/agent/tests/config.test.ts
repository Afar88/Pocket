import { describe, expect, it } from "vitest";
import { assertAttributionTag, readAgentConfig } from "../src/config.js";

const privateKey = "0x" + "1".repeat(64);
const encPrivateKey = "0x" + "2".repeat(64);
const registry = "0x1111111111111111111111111111111111111111";
const agentAddress = "0x700E4d3Dd9379fA164AD3E0DeD8fe0731b02f2aE";

describe("agent environment configuration", () => {
  it("passes ATTRIBUTION_TAG through unchanged", () => {
    const config = readAgentConfig({
      AGENT_ADDRESS: agentAddress,
      AGENT_ENC_PRIVATE_KEY: encPrivateKey,
      REGISTRY_ADDRESS: registry,
      CELO_RPC: "https://rpc.example",
      ATTRIBUTION_TAG: "pocket_hackathon"
    });

    expect(config.attributionTag).toBe("pocket_hackathon");
  });

  it("refuses an empty attribution tag", () => {
    expect(() => assertAttributionTag("")).toThrow(/ATTRIBUTION_TAG is empty/);
  });

  it("rejects whitespace instead of trimming or modifying the tag", () => {
    const rawTag = " pocket_hackathon ";
    expect(readAgentConfig({
      AGENT_PRIVATE_KEY: privateKey,
      AGENT_ENC_PRIVATE_KEY: encPrivateKey,
      REGISTRY_ADDRESS: registry,
      ATTRIBUTION_TAG: rawTag
    }).attributionTag).toBe(rawTag);
    expect(() => assertAttributionTag(rawTag)).toThrow(/lowercase letters/);
  });
  it("rejects a missing or malformed AGENT_ENC_PRIVATE_KEY", () => {
    expect(() => readAgentConfig({
      AGENT_PRIVATE_KEY: privateKey,
      REGISTRY_ADDRESS: registry,
      ATTRIBUTION_TAG: "pocket_hackathon"
    })).toThrow(/AGENT_ENC_PRIVATE_KEY/);
    expect(() => readAgentConfig({
      AGENT_PRIVATE_KEY: privateKey,
      AGENT_ENC_PRIVATE_KEY: "0x1234",
      REGISTRY_ADDRESS: registry,
      ATTRIBUTION_TAG: "pocket_hackathon"
    })).toThrow(/AGENT_ENC_PRIVATE_KEY/);
  });
  it("uses the public AGENT_ADDRESS and never needs the identity private key", () => {
    const config = readAgentConfig({
      AGENT_ADDRESS: agentAddress.toLowerCase(),
      AGENT_ENC_PRIVATE_KEY: encPrivateKey,
      REGISTRY_ADDRESS: registry,
      ATTRIBUTION_TAG: "pocket_hackathon"
    });
    expect(config.agentAddress).toBe(agentAddress);
    expect(Object.keys(config)).not.toContain("privateKey");
  });

  it("still derives the address from a legacy AGENT_PRIVATE_KEY without keeping the key", () => {
    const config = readAgentConfig({
      AGENT_PRIVATE_KEY: privateKey,
      AGENT_ENC_PRIVATE_KEY: encPrivateKey,
      REGISTRY_ADDRESS: registry,
      ATTRIBUTION_TAG: "pocket_hackathon"
    });
    expect(config.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(JSON.stringify(config)).not.toContain(privateKey.slice(2));
  });

  it("refuses to start without AGENT_ADDRESS or a legacy key, or with a malformed address", () => {
    expect(() => readAgentConfig({
      AGENT_ENC_PRIVATE_KEY: encPrivateKey,
      REGISTRY_ADDRESS: registry,
      ATTRIBUTION_TAG: "pocket_hackathon"
    })).toThrow(/AGENT_ADDRESS is required/);
    expect(() => readAgentConfig({
      AGENT_ADDRESS: "0x1234",
      AGENT_ENC_PRIVATE_KEY: encPrivateKey,
      REGISTRY_ADDRESS: registry,
      ATTRIBUTION_TAG: "pocket_hackathon"
    })).toThrow(/AGENT_ADDRESS must be/);
  });
});
