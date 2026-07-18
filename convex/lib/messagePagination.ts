import type { PaginationOptions, PaginationResult } from "convex/server";
import { FILTER_SCAN_ROW_LIMIT } from "../../shared/messageFilters";

export { FILTER_SCAN_ROW_LIMIT } from "../../shared/messageFilters";

interface PaginateMatchingOptions<T> {
  paginationOpts: PaginationOptions;
  selectionActive: boolean;
  matches: (value: T) => boolean;
  loadPage: (paginationOpts: PaginationOptions) => Promise<PaginationResult<T>>;
}

export interface MatchingPaginationResult<T> extends PaginationResult<T> {
  scannedRows: number;
  scanLimitReached: boolean;
}

/**
 * Scan one larger raw page and filter it on the server. Convex allows only one
 * paginated query per function, so every match from the raw page must be
 * returned before its continuation cursor advances.
 */
export async function paginateMatching<T>({
  paginationOpts,
  selectionActive,
  matches,
  loadPage,
}: PaginateMatchingOptions<T>): Promise<MatchingPaginationResult<T>> {
  if (!selectionActive) {
    const result = await loadPage(paginationOpts);
    return {
      ...result,
      scannedRows: result.page.length,
      scanLimitReached: false,
    };
  }

  const result = await loadPage({
    ...paginationOpts,
    numItems: FILTER_SCAN_ROW_LIMIT,
  });
  return {
    ...result,
    page: result.page.filter(matches),
    scannedRows: result.page.length,
    scanLimitReached: !result.isDone,
  };
}
