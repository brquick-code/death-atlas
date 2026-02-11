// web/app/components/DeathAtlasMap.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

type Row = {
  id: string | number;
  name: string | null;
  death_date: string | null;
  source_type: string | null; // "death" | "burial_fallback"
  lat: number;
  lon: number;

  wikidata_qid?: string | null;
  wikidata_url?: string | null;
  wikipedia_url?: string | null;
  findagrave_memorial_id?: string | null;
  findagrave_url?: string | null;
};

// react-leaflet components must be client-side
const MapContainer = dynamic(
  () => import("react-leaflet").then((m) => m.MapContainer),
  { ssr: false }
);
const TileLayer = dynamic(
  () => import("react-leaflet").then((m) => m.TileLayer),
  { ssr: false }
);
const Marker = dynamic(
  () => import("react-leaflet").then((m) => m.Marker),
  { ssr: false }
);
const Popup = dynamic(
  () => import("react-leaflet").then((m) => m.Popup),
  { ssr: false }
);

export default function DeathAtlasMap() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Default view (USA-ish). Change to whatever you want.
  const center = useMemo<[number, number]>(() => [39.5, -98.35], []);
  const zoom = 4;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Basic load (limited). Later you can switch to loading by bounds.
        const res = await fetch("/api/death-locations");
        const json = await res.json();

        if (!res.ok) throw new Error(json?.error ?? "Failed to load");
        if (!cancelled) setRows(json.rows ?? []);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Unknown error");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="p-4 text-sm text-red-600">
        Error loading map data: {error}
      </div>
    );
  }

  return (
    <div className="w-full h-[80vh] rounded-xl overflow-hidden">
      <MapContainer center={center} zoom={zoom} style={{ width: "100%", height: "100%" }}>
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {rows.map((r) => {
          const wikidataUrl =
            r.wikidata_url ??
            (r.wikidata_qid ? `https://www.wikidata.org/wiki/${r.wikidata_qid}` : null);

          const wikipediaUrl = r.wikipedia_url ?? null;
          const findAGraveUrl = r.findagrave_url ?? null;

          return (
            <Marker key={String(r.id)} position={[r.lat, r.lon]}>
              <Popup>
                <div style={{ minWidth: 240 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>
                    {r.name ?? "Unknown"}
                  </div>

                  {r.death_date ? (
                    <div style={{ fontSize: 12, marginBottom: 6 }}>
                      <strong>Died:</strong> {r.death_date}
                    </div>
                  ) : null}

                  {r.source_type === "burial_fallback" ? (
                    <div style={{ fontSize: 12, marginBottom: 8 }}>
                      ⚠️ Showing burial location (death coordinates unknown)
                    </div>
                  ) : null}

                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                    {wikipediaUrl ? (
                      <a href={wikipediaUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                        Wikipedia
                      </a>
                    ) : (
                      <span style={{ fontSize: 12, opacity: 0.7 }}>
                        Wikipedia: not available
                      </span>
                    )}

                    {findAGraveUrl ? (
                      <a href={findAGraveUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                        Find a Grave
                      </a>
                    ) : (
                      <span style={{ fontSize: 12, opacity: 0.7 }}>
                        Find a Grave: not available
                      </span>
                    )}

                    {wikidataUrl ? (
                      <a href={wikidataUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                        Wikidata
                      </a>
                    ) : null}
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
