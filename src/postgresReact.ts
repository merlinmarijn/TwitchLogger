import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiOperation, PaginationResult } from "./api";
import { workerUrl } from "./runtimeConfig";

export type PaginationStatus =
  | "LoadingFirstPage"
  | "CanLoadMore"
  | "LoadingMore"
  | "Exhausted"
  | "Error";

export function useQuery<Args, Result>(operation: ApiOperation<Args, Result>, args: Args | "skip") {
  const [result, setResult] = useState<Result>();
  const key = args === "skip" ? "skip" : JSON.stringify(args);
  useEffect(() => {
    if (args === "skip") return;
    let active = true;
    let loading = false;
    let timer: number | undefined;
    let nextDelay = operation.pollIntervalMs ?? 0;
    const controller = new AbortController();
    const load = () => {
      if (loading) return;
      loading = true;
      void request(operation, args, controller.signal)
        .then((value) => {
          if (!active) return;
          setResult(value);
          nextDelay = operation.pollIntervalMs ?? 0;
        })
        .catch((error) => {
          if (active && !isAbortError(error)) {
            console.error("PostgreSQL query failed", error);
            nextDelay = backoffDelay(nextDelay || 1_000);
          }
        })
        .finally(() => {
          loading = false;
          if (active && operation.pollIntervalMs) {
            timer = window.setTimeout(load, nextDelay);
          }
        });
    };
    load();
    return () => {
      active = false;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  // key tracks argument values without requiring callers to memoize objects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation.path, operation.pollIntervalMs, key]);
  return args === "skip" ? undefined : result;
}

export function useMutation<Args, Result>(operation: ApiOperation<Args, Result>) {
  return useCallback((args: Args) => request(operation, args), [operation]);
}

export function usePaginatedQuery<Args extends object, Result extends { _id: string }>(
  operation: ApiOperation<Args, PaginationResult<Result>>,
  args: Omit<Args, "paginationOpts"> | "skip",
  options: { initialNumItems: number },
) {
  const argsKey = args === "skip" ? "skip" : JSON.stringify(args);
  const [liveResults, setLiveResults] = useState<Result[]>([]);
  const [historyResults, setHistoryResults] = useState<Result[]>([]);
  const [historyStarted, setHistoryStarted] = useState(false);
  const historyStartedRef = useRef(false);
  const [cursor, setCursor] = useState("");
  const [isDone, setIsDone] = useState(false);
  const [loadingFirstPage, setLoadingFirstPage] = useState(args !== "skip");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    if (args === "skip") {
      return;
    }

    let active = true;
    let loading = false;
    let timer: number | undefined;
    let nextDelay = operation.pollIntervalMs ?? 0;
    const controller = new AbortController();
    const load = () => {
      if (loading) return;
      loading = true;
      void request(operation, {
        ...args,
        paginationOpts: { numItems: options.initialNumItems, cursor: null },
      } as Args, controller.signal)
        .then((value) => {
          if (!active) return;
          setLiveResults(value.page);
          setError(undefined);
          nextDelay = operation.pollIntervalMs ?? 0;
          if (!historyStartedRef.current) {
            setCursor(value.continueCursor);
            setIsDone(value.isDone);
          }
        })
        .catch((cause) => {
          if (!active || isAbortError(cause)) return;
          setError(errorMessage(cause));
          nextDelay = backoffDelay(nextDelay || 1_000);
        })
        .finally(() => {
          loading = false;
          if (active) setLoadingFirstPage(false);
          if (active && operation.pollIntervalMs) {
            timer = window.setTimeout(load, nextDelay);
          }
        });
    };
    queueMicrotask(() => {
      if (!active) return;
      setLiveResults([]);
      setHistoryResults([]);
      setHistoryStarted(false);
      historyStartedRef.current = false;
      setCursor("");
      setIsDone(false);
      setError(undefined);
      setLoadingMore(false);
      setLoadingFirstPage(true);
      load();
    });
    return () => {
      active = false;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  // argsKey represents all argument values.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    operation.path,
    operation.pollIntervalMs,
    argsKey,
    options.initialNumItems,
    retryRevision,
  ]);

  const loadMore = useCallback((numItems: number) => {
    if (args === "skip" || isDone || loadingMore || !cursor) return;
    if (!historyStartedRef.current) {
      historyStartedRef.current = true;
      setHistoryStarted(true);
      setHistoryResults(liveResults);
    }
    setLoadingMore(true);
    setError(undefined);
    void request(operation, {
      ...args,
      paginationOpts: {
        numItems: Math.max(1, Math.min(Math.floor(numItems), 250)),
        cursor,
      },
    } as Args)
      .then((value) => {
        setHistoryResults((current) => mergeById(current, value.page));
        setCursor(value.continueCursor);
        setIsDone(value.isDone);
      })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setLoadingMore(false));
  }, [args, cursor, isDone, liveResults, loadingMore, operation]);
  const results = useMemo(
    () => historyStarted ? mergeById(liveResults, historyResults) : liveResults,
    [historyResults, historyStarted, liveResults],
  );
  const status = useMemo<PaginationStatus>(() => {
    if (loadingFirstPage && results.length === 0) return "LoadingFirstPage";
    if (error && results.length === 0) return "Error";
    if (loadingMore) return "LoadingMore";
    return isDone ? "Exhausted" : "CanLoadMore";
  }, [error, isDone, loadingFirstPage, loadingMore, results.length]);
  const retry = useCallback(() => setRetryRevision((current) => current + 1), []);
  return {
    results: args === "skip" ? [] : results,
    status,
    loadMore,
    error,
    retry,
  };
}

async function request<Args, Result>(
  operation: ApiOperation<Args, Result>,
  args: Args,
  signal?: AbortSignal,
) {
  const response = await fetch(`${workerUrl}${operation.path}`, {
    method: operation.method,
    credentials: "include",
    signal,
    ...(operation.method === "POST"
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) }
      : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}`);
  return body as Result;
}

function mergeById<Result extends { _id: string }>(first: Result[], second: Result[]) {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  const seen = new Set(first.map((item) => item._id));
  return [...first, ...second.filter((item) => !seen.has(item._id))];
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The message service is unavailable";
}

function backoffDelay(current: number) {
  return Math.min(Math.max(current * 2, 2_000), 60_000);
}
