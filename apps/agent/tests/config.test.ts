import { describe, expect, it } from "vitest";
import { assertAttributionTag, readAgentConfig } from "../src/config.js";

const privateKey = "0x" + "1".repeat(64);
const encPrivateKey = "0x" + "2".repeat(64);
const registry = "0x1111111111111111111111111111111111111111";

describe("agent environment configuration", () => {
  it("passes ATTRIBUTION_TAG through unchanged", () => {
    const config = readAgentConfig({
      AGENT_PRIVATE_KEY: privateKey,
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
});
