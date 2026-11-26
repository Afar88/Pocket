import PocketReceipt from "./receipt-client";

export const dynamic = "force-dynamic";

export default async function ReceiptPage({
  params
}: {
  params: Promise<{ pocketId: string; txHash: string }>;
}) {
  const { pocketId, txHash } = await params;
  return <PocketReceipt pocketId={pocketId} txHash={txHash} />;
}
