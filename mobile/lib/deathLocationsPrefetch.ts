// mobile/lib/deathLocationsPrefetch.ts
// Tiny in-memory cache so the splash can prefetch the first map payload
// and the map screen can reuse it instantly.

type CacheEntry = {
  data?: any;
  promise?: Promise<any>;
};

const cache: Record<string, CacheEntry> = {};

export function prime(url: string, fetcher: () => Promise<any>) {
  if (!url) return;
  const entry = cache[url];

  // already have data or an in-flight request
  if (entry?.data || entry?.promise) return;

  const promise = fetcher()
    .then((json) => {
      cache[url] = { data: json };
      return json;
    })
    .catch((err) => {
      // clear failed entry so later calls can retry
      delete cache[url];
      throw err;
    });

  cache[url] = { promise };
}

export async function getOrFetch(url: string, fetcher: () => Promise<any>) {
  if (!url) return fetcher();

  const entry = cache[url];

  if (entry?.data) return entry.data;
  if (entry?.promise) return entry.promise;

  // create & await
  prime(url, fetcher);
  const created = cache[url];
  if (created?.promise) return created.promise;

  // fallback (shouldn't happen)
  return fetcher();
}
