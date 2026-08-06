export type ImageStorageTier = "hot" | "cold";

export interface IndexedImageRecord {
  id: string;
  imageUrls: readonly string[];
  storageTier: ImageStorageTier;
  timestamp: number;
}

export interface ImageOwner {
  id: string;
  storageTier: ImageStorageTier;
  timestamp: number;
}

export interface DeduplicatedImageUrls {
  imageUrls: string[];
  removedCount: number;
  suppressedUrls: string[];
}

export function collectOldestImageOwners(
  owners: Map<string, ImageOwner>,
  record: IndexedImageRecord,
) {
  for (const url of record.imageUrls) {
    const current = owners.get(url);
    if (!current || compareOwners(record, current) < 0) {
      owners.set(url, {
        id: record.id,
        storageTier: record.storageTier,
        timestamp: record.timestamp,
      });
    }
  }
}

export function deduplicateImageUrls(
  owners: ReadonlyMap<string, ImageOwner>,
  record: IndexedImageRecord,
): DeduplicatedImageUrls {
  const imageUrls: string[] = [];
  const suppressedUrls = new Set<string>();
  const retained = new Set<string>();
  let removedCount = 0;

  for (const url of record.imageUrls) {
    const owner = owners.get(url);
    const ownedByRecord = owner !== undefined &&
      owner.id === record.id &&
      owner.storageTier === record.storageTier &&
      owner.timestamp === record.timestamp;
    if (ownedByRecord && !retained.has(url)) {
      retained.add(url);
      imageUrls.push(url);
      continue;
    }
    removedCount += 1;
    if (!ownedByRecord) suppressedUrls.add(url);
  }

  return { imageUrls, removedCount, suppressedUrls: [...suppressedUrls] };
}

function compareOwners(left: ImageOwner, right: ImageOwner) {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  const idComparison = left.id.localeCompare(right.id);
  if (idComparison !== 0) return idComparison;
  return left.storageTier.localeCompare(right.storageTier);
}
