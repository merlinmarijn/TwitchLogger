import { ConvexError } from "convex/values";

export function requireIngestionSecret(value: string) {
  const configured = process.env.INGESTION_SECRET;
  if (!configured || value.length !== configured.length) {
    throw new ConvexError("Unauthorized ingestion request");
  }

  let mismatch = 0;
  for (let index = 0; index < value.length; index += 1) {
    mismatch |= value.charCodeAt(index) ^ configured.charCodeAt(index);
  }
  if (mismatch !== 0) throw new ConvexError("Unauthorized ingestion request");
}
