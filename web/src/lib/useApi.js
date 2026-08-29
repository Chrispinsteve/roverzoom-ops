import { useCallback, useEffect, useRef, useState } from 'react';

// Data loading with the behaviors an operations console needs:
//  - a `refresh` that does NOT blank the screen (an operator mid-read must not
//    lose what they were looking at every time the poll fires)
//  - optional polling, paused while the tab is hidden so a console left open
//    overnight is not hammering the API
//  - in-flight requests abandoned on unmount
export function useApi(fetcher, { deps = [], poll = null, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  const mounted = useRef(true);
  const fetcherRef = useRef(fetcher);

  // Kept current in an effect rather than during render: writing a ref while
  // rendering is a side effect, and under StrictMode's double render it can
  // latch a fetcher from a render that was thrown away. Declared FIRST so it
  // runs before the effects below that call through it.
  useEffect(() => { fetcherRef.current = fetcher; });

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = useCallback(async ({ quiet = false } = {}) => {
    if (!enabled) return;
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (!mounted.current) return;
      setData(result);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (!mounted.current || err.name === 'AbortError') return;
      // A failed background refresh keeps the last good data on screen and
      // surfaces the error alongside it, rather than replacing a working board
      // with an error page.
      setError(err);
    } finally {
      if (mounted.current) { setLoading(false); setRefreshing(false); }
    }
  }, [enabled]);

  // Fetching on mount necessarily flips a loading flag from inside an effect;
  // that is precisely this hook's job. The rule targets cascading-render bugs,
  // which this is not — `run` is idempotent and guarded by `mounted`.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { run(); }, deps);

  useEffect(() => {
    if (!poll || !enabled) return;
    let timer = null;
    const tick = () => { if (!document.hidden) run({ quiet: true }); };
    timer = setInterval(tick, poll);
    // Catch up immediately when the operator comes back to the tab.
    const onVisible = () => { if (!document.hidden) run({ quiet: true }); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [poll, enabled, run]);

  return {
    data, error, loading, refreshing, updatedAt,
    refresh: () => run({ quiet: true }),
    reload: () => run(),
    setData,
  };
}
