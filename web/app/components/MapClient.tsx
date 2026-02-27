"use client";

import React, { useEffect, useRef } from "react";
import L from "leaflet";

type MapPoint = {
  lat: number;
  lng: number;
  count: number; // >=2 means cluster
  id?: string; // present for raw points (zoomed in)
  title?: string;
};

type AnyPoint = {
  id?: string;
  title?: string;
  lat?: number;
  lng?: number;
  latitude?: number;
  longitude?: number;
  count?: number;
};

type PersonNear = {
  id: string;
  title: string;
  wikipedia_url?: string | null;
  source_url?: string | null;
  source_urls?: string[] | null;
  death_date?: string | null;
  date_start?: string | null;
  date_end?: string | null;
  confidence?: string | null;
  coord_source?: string | null;
  pageviews_365d?: number | null;
  is_celebrity?: boolean | null;
  lat?: number | null;
  lng?: number | null;
};

type Props = {
  initialCenter?: [number, number];
  initialZoom?: number;
  assumeRawPoints?: boolean;
  minZoom?: number;
  maxZoom?: number;
  className?: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function normalizePoints(data: unknown): MapPoint[] {
  if (!Array.isArray(data)) return [];
  const out: MapPoint[] = [];

  for (const item of data as AnyPoint[]) {
    const lat =
      typeof item.lat === "number"
        ? item.lat
        : typeof item.latitude === "number"
          ? item.latitude
          : NaN;

    const lng =
      typeof item.lng === "number"
        ? item.lng
        : typeof item.longitude === "number"
          ? item.longitude
          : NaN;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const count =
      typeof item.count === "number" && Number.isFinite(item.count)
        ? item.count
        : 1;

    const p: MapPoint = { lat, lng, count };

    if (typeof item.id === "string" && item.id.length > 0) p.id = item.id;
    if (typeof item.title === "string" && item.title.length > 0) p.title = item.title;

    out.push(p);
  }

  return out;
}

function latLngToTileXY(lat: number, lng: number, z: number) {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, z);
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

function tileXYToBounds(x: number, y: number, z: number) {
  const n = Math.pow(2, z);

  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;

  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));

  const north = (northRad * 180) / Math.PI;
  const south = (southRad * 180) / Math.PI;

  return { south, west, north, east };
}

function tileKey(z: number, x: number, y: number) {
  return `${z}/${x}/${y}`;
}

function pointKey(p: MapPoint) {
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return `${r(p.lat)},${r(p.lng)},${p.count},${p.id ?? ""}`;
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(d?: string | null) {
  return d ? d : "";
}

function formatCount(n: number) {
  const v = Math.max(1, Math.floor(n));
  if (v >= 1_000_000) return `${Math.round(v / 100_000) / 10}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${Math.round(v / 100) / 10}k`;
  return String(v);
}

function makeRedPinSvg(withBadge: boolean, badgeText: string) {
  const fill = "#DC2626";
  const stroke = "#7F1D1D";

  const badgeFill = "#111827";
  const badgeStroke = "rgba(255,255,255,0.25)";
  const badgeTextFill = "#FFFFFF";

  const badge = withBadge
    ? `
      <g transform="translate(13,6)">
        <rect x="-12" y="-9" rx="9" ry="9" width="24" height="18"
          fill="${badgeFill}" stroke="${badgeStroke}" stroke-width="1"/>
        <text x="0" y="5" text-anchor="middle"
          font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial"
          font-size="10" font-weight="800" fill="${badgeTextFill}">
          ${escapeHtml(badgeText)}
        </text>
      </g>
    `
    : "";

  return `
  <svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">
    <path d="M17 33s10-10.3 10-18.6C27 8.5 22.5 4 17 4S7 8.5 7 14.4C7 22.7 17 33 17 33z"
      fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>
    <circle cx="17" cy="14" r="4.2" fill="#FFFFFF" opacity="0.92"/>
    ${badge}
  </svg>
  `;
}

function makePinIcon(withBadge: boolean, badgeText: string) {
  const svg = makeRedPinSvg(withBadge, badgeText);

  return L.divIcon({
    className: "death-pin",
    html: svg,
    iconSize: [34, 34],
    iconAnchor: [17, 33],
    popupAnchor: [0, -28],
  });
}

declare global {
  interface Window {
    __deathAtlasFocusPerson?: (id: string) => void;
  }
}

export default function MapClient({
  initialCenter = [39.8283, -98.5795],
  initialZoom = 4,
  assumeRawPoints = false,
  minZoom = 2,
  maxZoom = 18,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  const dotsLayerRef = useRef<L.LayerGroup | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const popupAbortRef = useRef<AbortController | null>(null);

  const tileCacheRef = useRef<Map<string, MapPoint[]>>(new Map());
  const debounceRef = useRef<number | null>(null);

  const lastNearResultsRef = useRef<Map<string, PersonNear>>(new Map());

  const DETAIL_ZOOM = 9;
  const PERSON_ZOOM = 16;

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      preferCanvas: true,
      minZoom,
      maxZoom,
      worldCopyJump: true,
    }).setView(initialCenter, initialZoom);

    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom,
    }).addTo(map);

    const dotsLayer = L.layerGroup().addTo(map);
    dotsLayerRef.current = dotsLayer;

    function setNearCache(list: PersonNear[]) {
      lastNearResultsRef.current.clear();
      for (const p of list) {
        if (p?.id) lastNearResultsRef.current.set(p.id, p);
      }
    }

    async function fetchPeopleNear(lat: number, lng: number) {
      if (popupAbortRef.current) popupAbortRef.current.abort();
      const ac = new AbortController();
      popupAbortRef.current = ac;

      const url =
        `/api/death-near?lat=${encodeURIComponent(lat)}` +
        `&lng=${encodeURIComponent(lng)}` +
        `&radiusM=${encodeURIComponent(1500)}` +
        `&limit=${encodeURIComponent(50)}`;

      const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

      const json = await res.json();
      const data: PersonNear[] = Array.isArray((json as any)?.data)
        ? (json as any).data
        : Array.isArray(json)
          ? (json as any)
          : [];

      setNearCache(data);
      return data;
    }

    async function fetchOneById(id: string): Promise<PersonNear> {
      if (popupAbortRef.current) popupAbortRef.current.abort();
      const ac = new AbortController();
      popupAbortRef.current = ac;

      const url = `/api/death-one?id=${encodeURIComponent(id)}`;
      const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

      const one = (await res.json()) as PersonNear;
      if (one?.id) setNearCache([one]);
      return one;
    }

    async function fetchSameSpot(id: string): Promise<PersonNear[]> {
      if (popupAbortRef.current) popupAbortRef.current.abort();
      const ac = new AbortController();
      popupAbortRef.current = ac;

      const url = `/api/death-same-spot?id=${encodeURIComponent(id)}`;
      const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

      const json = await res.json();
      const data: PersonNear[] = Array.isArray((json as any)?.data)
        ? (json as any).data
        : Array.isArray(json)
          ? (json as any)
          : [];

      setNearCache(data);
      return data;
    }

    function openPersonPopup(p: PersonNear) {
      const lat = p.lat;
      const lng = p.lng;
      if (typeof lat !== "number" || typeof lng !== "number") return;

      const title = escapeHtml(p.title ?? "Unknown");

      const death = formatDate(p.death_date ?? p.date_end ?? p.date_start);
      const metaBits: string[] = [];
      if (death) metaBits.push(`d. ${escapeHtml(death)}`);
      if (p.confidence) metaBits.push(escapeHtml(p.confidence));
      if (p.coord_source) metaBits.push(escapeHtml(p.coord_source));

      const meta = metaBits.length
        ? `<div style="opacity:.75;font-size:12px;margin-top:4px">${metaBits.join(" · ")}</div>`
        : "";

      const links: string[] = [];
      if (p.wikipedia_url) {
        links.push(
          `<a href="${escapeHtml(p.wikipedia_url)}" target="_blank" rel="noreferrer">Wikipedia</a>`
        );
      }
      if (p.source_url) {
        links.push(
          `<a href="${escapeHtml(p.source_url)}" target="_blank" rel="noreferrer">Source</a>`
        );
      }

      const linksHtml = links.length
        ? `<div style="margin-top:8px;display:flex;gap:12px;font-size:13px">${links.join("")}</div>`
        : "";

      const content = `
        <div style="min-width:280px;max-width:360px">
          <div style="font-weight:800">${title}</div>
          ${meta}
          ${linksHtml}
          <div style="margin-top:10px;opacity:.7;font-size:12px">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
        </div>
      `;

      map.setView([lat, lng], Math.max(map.getZoom(), PERSON_ZOOM), { animate: true });

      window.setTimeout(() => {
        L.popup({
          closeButton: true,
          autoPan: false,
          keepInView: false,
          closeOnClick: true,
        })
          .setLatLng([lat, lng])
          .setContent(content)
          .openOn(map);
      }, 150);
    }

    window.__deathAtlasFocusPerson = (id: string) => {
      const p = lastNearResultsRef.current.get(id);
      if (!p) return;
      openPersonPopup(p);
    };

    function popupHtmlForPeople(people: PersonNear[]) {
      if (!people.length) {
        return `
          <div style="min-width:260px">
            <div style="font-weight:700;margin-bottom:6px">No entries found</div>
            <div style="opacity:.8">Try zooming in or clicking closer to a pin.</div>
          </div>
        `;
      }

      const items = people
        .map((p, idx) => {
          const title = escapeHtml(p.title ?? "Unknown");
          const death = formatDate(p.death_date ?? p.date_end ?? p.date_start);

          const metaBits: string[] = [];
          if (death) metaBits.push(`d. ${escapeHtml(death)}`);
          if (p.confidence) metaBits.push(escapeHtml(p.confidence));
          if (p.coord_source) metaBits.push(escapeHtml(p.coord_source));

          const meta = metaBits.length
            ? ` <span style="opacity:.75;font-size:12px">(${metaBits.join(" · ")})</span>`
            : "";

          const id = escapeHtml(p.id);
          const link = `<a href="#" onclick="window.__deathAtlasFocusPerson && window.__deathAtlasFocusPerson('${id}'); return false;" style="text-decoration:none">${title}</a>`;

          return `<li style="margin:6px 0;line-height:1.2">${idx + 1}. ${link}${meta}</li>`;
        })
        .join("");

      const titleLine = people.length === 1 ? "Entry" : `Entries at this location (${people.length})`;

      return `
        <div style="min-width:320px;max-width:380px">
          <div style="font-weight:800;margin-bottom:8px">${escapeHtml(titleLine)}</div>
          <ol style="padding-left:18px;margin:0">${items}</ol>
          <div style="margin-top:10px;opacity:.65;font-size:12px">
            Click a name to jump to that exact location
          </div>
        </div>
      `;
    }

    function openListPopupAt(lat: number, lng: number, people: PersonNear[]) {
      L.popup({ closeButton: true, autoPan: true })
        .setLatLng([lat, lng])
        .setContent(popupHtmlForPeople(people))
        .openOn(map);
    }

    function openNearbyPopup(lat: number, lng: number) {
      const loadingPopup = L.popup({ closeButton: true, autoPan: true })
        .setLatLng([lat, lng])
        .setContent(
          `<div style="min-width:260px"><div style="font-weight:700">Loading…</div><div style="opacity:.8">Fetching nearby entries</div></div>`
        )
        .openOn(map);

      fetchPeopleNear(lat, lng)
        .then((people) => {
          loadingPopup.setContent(popupHtmlForPeople(people));
        })
        .catch((err: any) => {
          if (err?.name === "AbortError") return;
          loadingPopup.setContent(
            `<div style="min-width:260px"><div style="font-weight:800">Error</div><div style="opacity:.85">${escapeHtml(
              err?.message ?? "Failed to load nearby entries"
            )}</div></div>`
          );
        });
    }

    function renderPins(points: MapPoint[]) {
      dotsLayer.clearLayers();

      for (const p of points) {
        const isCluster = p.count >= 2;
        const badgeText = isCluster ? formatCount(p.count) : "";
        const icon = makePinIcon(isCluster, badgeText);

        const m = L.marker([p.lat, p.lng], { icon });

        m.on("click", async () => {
          const currentZoom = map.getZoom();

          if (isCluster && currentZoom < DETAIL_ZOOM) {
            const nextZoom = clamp(currentZoom + 2, currentZoom + 1, DETAIL_ZOOM);
            map.setView([p.lat, p.lng], nextZoom, { animate: true });
            return;
          }

          if (!isCluster && p.id) {
            try {
              const list = await fetchSameSpot(p.id);

              if (list.length >= 2) {
                const lat = (list[0]?.lat ?? p.lat) as number;
                const lng = (list[0]?.lng ?? p.lng) as number;
                openListPopupAt(lat, lng, list);
                return;
              }

              const one = list.length === 1 ? list[0] : await fetchOneById(p.id);
              openPersonPopup(one);
            } catch (err: any) {
              if (err?.name === "AbortError") return;
              openNearbyPopup(p.lat, p.lng);
            }
            return;
          }

          openNearbyPopup(p.lat, p.lng);
        });

        m.addTo(dotsLayer);
      }
    }

    async function fetchTile(z: number, x: number, y: number, signal: AbortSignal) {
      const key = tileKey(z, x, y);

      const cached = tileCacheRef.current.get(key);
      if (cached) return cached;

      const b = tileXYToBounds(x, y, z);

      const url =
        `/api/death-locations?minLat=${encodeURIComponent(b.south)}` +
        `&minLng=${encodeURIComponent(b.west)}` +
        `&maxLat=${encodeURIComponent(b.north)}` +
        `&maxLng=${encodeURIComponent(b.east)}` +
        `&zoom=${encodeURIComponent(z)}`;

      const res = await fetch(url, { signal, cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

      const json = await res.json();

      const payload = Array.isArray(json)
        ? json
        : Array.isArray((json as any)?.data)
          ? (json as any).data
          : [];

      const points = normalizePoints(payload);

      tileCacheRef.current.set(key, points);

      // ✅ FIX: key could be undefined if map is empty for a split-second
      if (tileCacheRef.current.size > 400) {
        const it = tileCacheRef.current.keys().next();
        const firstKey: string | undefined = it && !it.done ? (it.value as string) : undefined;
        if (firstKey) tileCacheRef.current.delete(firstKey);
      }

      return points;
    }

    function tilesCoveringViewport(z: number, ring = 1) {
      const bounds = map.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();

      const t1 = latLngToTileXY(ne.lat, sw.lng, z);
      const t2 = latLngToTileXY(sw.lat, ne.lng, z);

      let minX = Math.min(t1.x, t2.x) - ring;
      let maxX = Math.max(t1.x, t2.x) + ring;
      let minY = Math.min(t1.y, t2.y) - ring;
      let maxY = Math.max(t1.y, t2.y) + ring;

      const n = Math.pow(2, z);

      minX = clamp(minX, 0, n - 1);
      maxX = clamp(maxX, 0, n - 1);
      minY = clamp(minY, 0, n - 1);
      maxY = clamp(maxY, 0, n - 1);

      const tiles: Array<{ x: number; y: number }> = [];
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) tiles.push({ x, y });
      }
      return tiles;
    }

    async function refreshFromTiles() {
      if (abortRef.current) abortRef.current.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      const z = map.getZoom();
      const tiles = tilesCoveringViewport(z, 1);

      try {
        const all = await Promise.all(tiles.map((t) => fetchTile(z, t.x, t.y, ac.signal)));

        const seen = new Set<string>();
        const merged: MapPoint[] = [];

        for (const arr of all) {
          for (const p of arr) {
            const k = pointKey(p);
            if (seen.has(k)) continue;
            seen.add(k);
            merged.push(p);
          }
        }

        renderPins(merged);
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        console.error("Tile refresh failed:", err);
      }
    }

    function scheduleRefresh() {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        refreshFromTiles();
      }, 150);
    }

    map.on("moveend", scheduleRefresh);
    map.on("zoomend", scheduleRefresh);

    refreshFromTiles();

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
      if (popupAbortRef.current) popupAbortRef.current.abort();

      if (window.__deathAtlasFocusPerson) delete window.__deathAtlasFocusPerson;

      map.off("moveend", scheduleRefresh);
      map.off("zoomend", scheduleRefresh);
      map.remove();

      mapRef.current = null;
      dotsLayerRef.current = null;
    };
  }, [initialCenter, initialZoom, minZoom, maxZoom, assumeRawPoints]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={
        className
          ? undefined
          : {
              width: "100%",
              height: "100%",
            }
      }
    />
  );
}