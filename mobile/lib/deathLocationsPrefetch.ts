// mobile/lib/deathLocationsPrefetch.ts
// Tiny in-memory cache so the splash can prefetch the first map payload
// and other screens can reuse it instantly.

type CacheEntry = {
  data?: any;
  promise?: Promise<any>;
};

const cache: Record<string, CacheEntry> = {};

// Default fetcher: fetch JSON from a URL
async function defaultFetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Fetch failed (${res.status}) ${url}${text ? ` :: ${text}` : ""}`);
  }
  return res.json();
}

/**
 * Prime the cache for a URL.
 * If `fetcher` is not provided, it will default to fetching JSON from `url`.
 */
export function prime(url: string, fetcher?: () => Promise<any>) {
  if (!url) return;

  const entry = cache[url];

  // Already have data or an in-flight request
  if (entry?.data || entry?.promise) return;

  const run = typeof fetcher === "function" ? fetcher : () => defaultFetchJson(url);

  const promise = run()
    .then((json) => {
      cache[url] = { data: json };
      return json;
    })
    .catch((err) => {
      // Clear failed entry so later calls can retry
      delete cache[url];
      throw err;
    });

  cache[url] = { promise };
}

/**
 * Get cached data for a URL, or fetch it and cache it.
 * If `fetcher` is not provided, it will default to fetching JSON from `url`.
 */
export async function getOrFetch(url: string, fetcher?: () => Promise<any>) {
  // If no URL is provided, we can't fetch by URL. Just run the provided fetcher.
  if (!url) {
    if (typeof fetcher === "function") return fetcher();
    throw new Error("getOrFetch: url is empty and no fetcher was provided.");
  }

  const entry = cache[url];

  if (entry?.data) return entry.data;
  if (entry?.promise) return entry.promise;

  const run = typeof fetcher === "function" ? fetcher : () => defaultFetchJson(url);

  // Create & await
  prime(url, run);
  const created = cache[url];
  if (created?.promise) return created.promise;

  // Fallback (shouldn't happen)
  return run();
}

/** Optional helper if you ever want to clear one URL or everything */
export function clear(url?: string) {
  if (!url) {
    for (const k of Object.keys(cache)) delete cache[k];
    return;
  }
  delete cache[url];
}
