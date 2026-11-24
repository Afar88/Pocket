import { NextResponse } from "next/server";
import { CELO_CHAIN_ID, CELO_RPC_DEFAULT } from "@pocket/core";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    chainId: CELO_CHAIN_ID,
    rpcUrl: process.env.CELO_RPC || CELO_RPC_DEFAULT,
    registryAddress: process.env.REGISTRY_ADDRESS || "",
    attributionTag: process.env.ATTRIBUTION_TAG || ""
  });
}
