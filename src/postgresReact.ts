import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiOperation, PaginationResult } from "./api";
import { workerUrl } from "./runtimeConfig";

export type PaginationStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

export function useQuery<Args, Result>(operation: ApiOperation<Args, Result>, args: Args | "skip") {
  const [result, setResult] = useState<Result>();
  const key = args === "skip" ? "skip" : JSON.stringify(args);
  useEffect(() => {
    if (args === "skip") return;
    let active = true;
    const load = () => void request(operation, args)
      .then((value) => { if (active) setResult(value); })
      .catch((error) => console.error("PostgreSQL query failed", error));
    load();
    const timer = operation.poll ? window.setInterval(load, 2_000) : undefined;
    return () => { active = false; if (timer !== undefined) window.clearInterval(timer); };
  // key tracks argument values without requiring callers to memoize objects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation.path, key]);
  return args === "skip" ? undefined : result;
}

export function useMutation<Args, Result>(operation: ApiOperation<Args, Result>) {
  return useCallback((args: Args) => request(operation, args), [operation]);
}

export function usePaginatedQuery<Args extends object, Result>(
  operation: ApiOperation<Args, PaginationResult<Result>>,
  args: Omit<Args, "paginationOpts"> | "skip",
  options: { initialNumItems: number },
) {
  const argsKey = args === "skip" ? "skip" : JSON.stringify(args);
  const [requested, setRequested] = useState(options.initialNumItems);
  const [results, setResults] = useState<Result[]>([]);
  const [isDone, setIsDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const previousKey = useRef(argsKey);

  useEffect(() => {
    if (previousKey.current === argsKey) return;
    previousKey.current = argsKey;
    setRequested(options.initialNumItems);
    setResults([]);
    setIsDone(false);
  }, [argsKey, options.initialNumItems]);

  useEffect(() => {
    if (args === "skip") return;
    let active = true;
    const load = () => {
      setLoading(true);
      void request(operation, { ...args, paginationOpts: { numItems: requested } } as Args)
        .then((value) => {
          if (!active) return;
          setResults(value.page);
          setIsDone(value.isDone);
        })
        .catch((error) => console.error("PostgreSQL page query failed", error))
        .finally(() => { if (active) setLoading(false); });
    };
    load();
    const timer = window.setInterval(load, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  // argsKey represents all argument values.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation.path, argsKey, requested]);

  const loadMore = useCallback((numItems: number) => {
    if (!isDone) setRequested((current) => current + numItems);
  }, [isDone]);
  const status = useMemo<PaginationStatus>(() => {
    if (loading && results.length === 0) return "LoadingFirstPage";
    if (loading) return "LoadingMore";
    return isDone ? "Exhausted" : "CanLoadMore";
  }, [isDone, loading, results.length]);
  return { results: args === "skip" ? [] : results, status, loadMore };
}

async function request<Args, Result>(operation: ApiOperation<Args, Result>, args: Args) {
  const response = await fetch(`${workerUrl}${operation.path}`, {
    method: operation.method,
    credentials: "include",
    ...(operation.method === "POST"
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) }
      : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}`);
  return body as Result;
}
