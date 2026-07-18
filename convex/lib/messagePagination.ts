import type { PaginationOptions, PaginationResult } from "convex/server";
import { FILTER_SCAN_ROW_LIMIT } from "../../shared/messageFilters";

export { FILTER_SCAN_ROW_LIMIT } from "../../shared/messageFilters";

interface PaginateMatchingOptions<T> {
  paginationOpts: PaginationOptions;
  selectionActive: boolean;
  matches: (value: T) => boolean;
  loadPage: (paginationOpts: PaginationOptions) => Promise<PaginationResult<T>>;
  canContinue?: () => boolean | Promise<boolean>;
}

export interface MatchingPaginationResult<T> extends PaginationResult<T> {
  scannedRows: number;
  scanLimitReached: boolean;
}

/**
 * Fill a filtered page on the server without losing the raw continuation cursor.
 * Each raw batch is returned in full or discarded in full, so matching rows are
 * never skipped between calls.
 */
export async function paginateMatching<T>({
  paginationOpts,
  selectionActive,
  matches,
  loadPage,
  canContinue = () => true,
}: PaginateMatchingOptions<T>): Promise<MatchingPaginationResult<T>> {
  if (!selectionActive) {
    const result = await loadPage(paginationOpts);
    return {
      ...result,
      scannedRows: result.page.length,
      scanLimitReached: false,
    };
  }

  const targetItems = paginationOpts.numItems;
  const batchSize = Math.min(targetItems, 100);
  const matchingPage: T[] = [];
  let scannedRows = 0;
  let cursor = paginationOpts.cursor;
  let lastResult: PaginationResult<T> | undefined;

  while (scannedRows < FILTER_SCAN_ROW_LIMIT) {
    const result = await loadPage({
      ...paginationOpts,
      cursor,
      numItems: Math.min(batchSize, FILTER_SCAN_ROW_LIMIT - scannedRows),
    });
    lastResult = result;
    scannedRows += result.page.length;
    matchingPage.push(...result.page.filter(matches));

    if (matchingPage.length >= targetItems || result.isDone || result.page.length === 0 ||
        result.pageStatus === "SplitRequired") break;
    if (!(await canContinue())) break;
    cursor = result.continueCursor;
  }

  if (!lastResult) throw new Error("Filtered pagination did not read a page");
  return {
    ...lastResult,
    page: matchingPage,
    scannedRows,
    scanLimitReached: !lastResult.isDone && matchingPage.length < targetItems,
  };
}
