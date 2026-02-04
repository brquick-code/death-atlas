import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  InteractionManager, // ✅ added
} from "react-native";
import MapView, { Marker, Region } from "react-native-maps";
import LocationPreviewCard from "../components/LocationPreviewCard";
import { getOrFetch } from "../lib/deathLocationsPrefetch";

type CoordMode = "death" | "burial";

type DeathLocation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;

  place_name?: string;
  category?: string;
  death_date?: string;

  wikipedia_url?: string;
  source_url?: string;
  source_urls?: string[];

  burial_latitude?: number;
  burial_longitude?: number;
  burial_place_name?: string;

  // cluster helpers
  is_cluster?: boolean;
  count?: number;
  members?: DeathLocation[];
};

type SearchResult = {
  id: string;
  title: string | null;
  name: string | null;

  place_name?: string | null;
  category?: string | null;
  death_date?: string | null;

  death_latitude: number | null;
  death_longitude: number | null;
  burial_latitude: number | null;
  burial_longitude: number | null;
  burial_place_name?: string | null;

  wikipedia_url?: string | null;
  source_url?: string | null;
  source_urls?: string[] | null;

  // some APIs return this shape
  lat?: number | null;
  lng?: number | null;
  coord_kind?: "death" | "burial" | null;
};

const CATEGORY_CHIPS = [
  { key: "all", label: "All" },
  { key: "murder", label: "Murder" },
  { key: "accident", label: "Accident" },
  { key: "natural", label: "Natural" },
  { key: "suicide", label: "Suicide" },
] as const;

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstNonEmpty(...vals: any[]): string | undefined {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s.length) return s;
  }
  return undefined;
}

function norm(s?: string) {
  return (s ?? "").toLowerCase().trim();
}

function categoryMatches(loc: DeathLocation, selected: string) {
  if (selected === "all") return true;
  const cat = norm(loc.category);

  if (selected === "murder")
    return cat.includes("murder") || cat.includes("assassination");

  if (selected === "accident") return cat.includes("accident");

  if (selected === "suicide") return cat.includes("suicide");

  if (selected === "natural")
    return (
      cat.includes("natural") ||
      cat.includes("natural causes") ||
      cat.includes("illness") ||
      cat.includes("disease") ||
      cat.includes("heart") ||
      cat.includes("stroke") ||
      cat.includes("cancer")
    );

  return true;
}

function regionToBbox(region: Region) {
  const latDelta = region.latitudeDelta ?? 0.2;
  const lngDelta = region.longitudeDelta ?? 0.2;
  const minLat = region.latitude - latDelta / 2;
  const maxLat = region.latitude + latDelta / 2;
  const minLng = region.longitude - lngDelta / 2;
  const maxLng = region.longitude + lngDelta / 2;
  return { minLat, maxLat, minLng, maxLng };
}

// Force high zoom so backend returns raw points (no grid clustering)
function requestZoomFromRegion(_region: Region) {
  return 20;
}

// Round coords so “same coordinate” matching is stable (handles float noise).
function coordKey(lat: number, lng: number) {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

// Only cluster when multiple entries share the SAME coords.
function clusterSameCoords(items: DeathLocation[]): DeathLocation[] {
  const buckets = new Map<string, DeathLocation[]>();

  for (const p of items) {
    const k = coordKey(p.latitude, p.longitude);
    const arr = buckets.get(k);
    if (arr) arr.push(p);
    else buckets.set(k, [p]);
  }

  const out: DeathLocation[] = [];

  for (const [k, arr] of buckets.entries()) {
    if (arr.length === 1) {
      out.push(arr[0]);
      continue;
    }

    const first = arr[0];
    const clusterId = `cluster-${k}`;
    const members = [...arr].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "")
    );

    out.push({
      id: clusterId,
      name: `Cluster (${arr.length})`,
      latitude: first.latitude,
      longitude: first.longitude,
      is_cluster: true,
      count: arr.length,
      members,
    });
  }

  return out;
}

/**
 * Supports BOTH API shapes:
 * - old: death_latitude/death_longitude + burial_latitude/burial_longitude
 * - new: lat/lng + coord_kind
 */
function extractCoordsForMode(
  row: any,
  mode: CoordMode
): { lat: number; lng: number } | null {
  const apiLat = safeNum(row.lat) ?? safeNum(row.latitude);
  const apiLng = safeNum(row.lng) ?? safeNum(row.longitude);
  const kind = (row.coord_kind ?? row.coordKind ?? row.coord_kind) as
    | "death"
    | "burial"
    | undefined;

  // If API gave coord_kind, trust it and filter strictly by current mode
  if (apiLat != null && apiLng != null && (kind === "death" || kind === "burial")) {
    if (mode === kind) return { lat: apiLat, lng: apiLng };
    return null;
  }

  // Otherwise fall back to schema columns
  if (mode === "burial") {
    const lat = safeNum(row.burial_latitude);
    const lng = safeNum(row.burial_longitude);
    if (lat === null || lng === null) return null;
    return { lat, lng };
  }

  const lat = safeNum(row.death_latitude) ?? safeNum(row.latitude) ?? safeNum(row.lat);
  const lng =
    safeNum(row.death_longitude) ??
    safeNum(row.longitude) ??
    safeNum(row.lng) ??
    safeNum(row.lon);

  if (lat === null || lng === null) return null;
  return { lat, lng };
}

/**
 * ✅ Directions helper (Apple Maps on iOS, Google Maps on Android; falls back to web)
 */
async function openDirections(lat: number, lng: number, label?: string) {
  const qLabel = (label || "Destination").trim();

  const apple = `http://maps.apple.com/?daddr=${encodeURIComponent(
    `${lat},${lng}`
  )}&q=${encodeURIComponent(qLabel)}`;

  const googleWeb = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    `${lat},${lng}`
  )}&travelmode=driving`;

  const androidIntent = `google.navigation:q=${encodeURIComponent(`${lat},${lng}`)}`;

  try {
    if (Platform.OS === "ios") {
      return Linking.openURL(apple);
    }

    const canIntent = await Linking.canOpenURL(androidIntent);
    if (canIntent) return Linking.openURL(androidIntent);

    return Linking.openURL(googleWeb);
  } catch {
    return Linking.openURL(googleWeb);
  }
}

export default function IndexMapScreen() {
  const mapRef = useRef<MapView | null>(null);

  const [region, setRegion] = useState<Region>({
    latitude: 39.5,
    longitude: -98.35,
    latitudeDelta: 18,
    longitudeDelta: 18,
  });

  const [coordMode, setCoordMode] = useState<CoordMode>("death");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  const [query, setQuery] = useState<string>("");
  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [searchLoading, setSearchLoading] = useState<boolean>(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [points, setPoints] = useState<DeathLocation[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [selected, setSelected] = useState<DeathLocation | null>(null);

  const [clusterOpen, setClusterOpen] = useState(false);
  const [clusterTitle, setClusterTitle] = useState<string>("Cluster");
  const [clusterItems, setClusterItems] = useState<DeathLocation[]>([]);
  const [clusterError, setClusterError] = useState<string | null>(null);

  const [renderMarkers, setRenderMarkers] = useState(false); // ✅ new

  const apiBase = (process.env.EXPO_PUBLIC_API_BASE_URL || "").replace(/\/$/, "");

  // ✅ Pin colors (Death = red, Burial = blue)
  const isBurial = coordMode === "burial";
  const pinColor = isBurial ? "#2563eb" : "#dc2626";
  const pinColorSelected = isBurial ? "#1e3a8a" : "#991b1b";

  // ✅ HARDENING:
  // - Clear selection AND points immediately on mode switch
  // - This prevents react-native-maps “selected marker” + big re-render crash
  useEffect(() => {
    setPreviewOpen(false);
    setSelected(null);

    setClusterOpen(false);
    setClusterItems([]);
    setClusterError(null);

    setPoints([]); // important: don’t keep old set around during mode flip
    setLoading(true);
    setError(null);
  }, [coordMode]);

  const fetchUrl = useMemo(() => {
    if (!apiBase) return "";
    const { minLat, maxLat, minLng, maxLng } = regionToBbox(region);
    const zoom = requestZoomFromRegion(region);

    return (
      `${apiBase}/api/death-locations` +
      `?minLat=${encodeURIComponent(minLat)}` +
      `&minLng=${encodeURIComponent(minLng)}` +
      `&maxLat=${encodeURIComponent(maxLat)}` +
      `&maxLng=${encodeURIComponent(maxLng)}` +
      `&zoom=${encodeURIComponent(zoom)}` +
      `&coord=${encodeURIComponent(coordMode)}` +
      `&published=true`
    );
  }, [apiBase, region, coordMode]);

  // ✅ Pre-warm UX: render the map first, then markers after interactions settle.
  // Prevents first-frame stutter when opening or after a new fetchUrl.
  useEffect(() => {
    setRenderMarkers(false);

    let cancelled = false;
    const task = InteractionManager.runAfterInteractions(() => {
      if (!cancelled) setRenderMarkers(true);
    });

    return () => {
      cancelled = true;
      (task as any)?.cancel?.();
    };
  }, [fetchUrl]);

  function parseRows(rows: any[], mode: CoordMode): DeathLocation[] {
    return rows
      .map((r) => {
        const coords = extractCoordsForMode(r, mode);
        if (!coords) return null;

        const placeStr =
          mode === "burial"
            ? firstNonEmpty(
                r.burial_place_name,
                r.place_name,
                r.location_name,
                r.place,
                r.death_place,
                r.city_state,
                r.city,
                r.state
              )
            : firstNonEmpty(
                r.place_name,
                r.location_name,
                r.place,
                r.death_place,
                r.city_state,
                r.city,
                r.state
              );

        const nameStr =
          firstNonEmpty(
            r.name,
            r.title,
            r.full_name,
            r.person_name,
            r.label,
            r.display_name,
            r.subject_name,
            r.primary_name
          ) ??
          placeStr ??
          "";

        if (!nameStr.trim()) return null;
        if (String(nameStr).toLowerCase().includes("sample person")) return null;

        const idStr =
          firstNonEmpty(
            r.id,
            r.anyId,
            r.wikidata_id,
            r.wikidataId,
            r.wd_id,
            r.slug,
            r.person_id,
            r.location_id
          ) ?? `${nameStr}-${coords.lat}-${coords.lng}`;

        return {
          id: String(idStr),
          name: String(nameStr),
          latitude: coords.lat,
          longitude: coords.lng,
          place_name: placeStr,
          category: firstNonEmpty(r.category, r.death_type, r.type),
          death_date: firstNonEmpty(r.death_date, r.date, r.died_on, r.date_end),
          wikipedia_url: firstNonEmpty(r.wikipedia_url, r.wikipedia),
          source_url: firstNonEmpty(r.source_url, r.source),
          source_urls: Array.isArray(r.source_urls)
            ? r.source_urls.filter(Boolean).map((x: any) => String(x))
            : undefined,
          burial_latitude: safeNum(r.burial_latitude) ?? undefined,
          burial_longitude: safeNum(r.burial_longitude) ?? undefined,
          burial_place_name: firstNonEmpty(r.burial_place_name),
        } as DeathLocation;
      })
      .filter(Boolean) as DeathLocation[];
  }

  // Map fetch
  useEffect(() => {
    let cancelled = false;
    let t: any;

    async function run() {
      try {
        setLoading(true);
        setError(null);

        if (!fetchUrl) {
          setPoints([]);
          setLoading(false);
          setError("Missing EXPO_PUBLIC_API_BASE_URL in mobile/.env");
          return;
        }

        const data = await getOrFetch(fetchUrl, async () => {
          const res = await fetch(fetchUrl);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`Fetch failed (${res.status}) ${txt}`.trim());
          }
          return res.json();
        });

        const rows: any[] = Array.isArray(data)
          ? data
          : Array.isArray((data as any)?.points)
          ? (data as any).points
          : [];

        const parsed = parseRows(rows, coordMode);
        const q = norm(query);

        const filtered = parsed.filter((p) => {
          if (!categoryMatches(p, selectedCategory)) return false;
          if (!q) return true;
          const n = norm(p.name);
          const pl = norm(p.place_name);
          const bp = norm(p.burial_place_name);
          return n.includes(q) || pl.includes(q) || bp.includes(q);
        });

        const clustered = clusterSameCoords(filtered);

        if (!cancelled) {
          setPoints(clustered);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setLoading(false);
          setError(e?.message || "Fetch failed.");
        }
      }
    }

    t = setTimeout(run, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [fetchUrl, coordMode, selectedCategory, query]);

  // Global typeahead search
  useEffect(() => {
    let cancelled = false;
    let t: any;

    async function run() {
      const q = query.trim();
      if (!q || q.length < 2) {
        setSearchResults([]);
        setSearchError(null);
        setSearchLoading(false);
        return;
      }

      if (!apiBase) {
        setSearchError("Missing EXPO_PUBLIC_API_BASE_URL in mobile/.env");
        return;
      }

      try {
        setSearchLoading(true);
        setSearchError(null);

        const url = `${apiBase}/api/search?q=${encodeURIComponent(q)}&limit=12&coord=${encodeURIComponent(
          coordMode
        )}`;
        const res = await fetch(url);
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(`Search failed (${res.status}) ${txt}`.trim());
        }

        const json = await res.json();
        const results: SearchResult[] = Array.isArray(json?.data) ? json.data : [];
        if (!cancelled) {
          setSearchResults(results);
          setSearchLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setSearchLoading(false);
          setSearchError(e?.message ?? "Search failed.");
        }
      }
    }

    t = setTimeout(run, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, apiBase, coordMode]);

  function zoomTo(lat: number, lng: number, factor: number) {
    mapRef.current?.animateToRegion(
      {
        latitude: lat,
        longitude: lng,
        latitudeDelta: Math.max(0.02, region.latitudeDelta * factor),
        longitudeDelta: Math.max(0.02, region.longitudeDelta * factor),
      },
      250
    );
  }

  function onPressMarker(item: DeathLocation) {
    if (item.is_cluster) {
      const members = item.members ?? [];

      // close any selection state first (prevents “selected marker” weirdness)
      setPreviewOpen(false);
      setSelected(null);

      setClusterTitle(item.count ? `Cluster (${item.count})` : "Cluster");
      setClusterItems(members);
      setClusterError(members.length ? null : "No names found for this cluster.");
      setClusterOpen(true);

      zoomTo(item.latitude, item.longitude, 0.6);
      return;
    }

    setClusterOpen(false);
    setClusterItems([]);
    setClusterError(null);

    setSelected(item);
    setPreviewOpen(true);
    zoomTo(item.latitude, item.longitude, 0.6);
  }

  function selectFromCluster(item: DeathLocation) {
    setClusterOpen(false);
    setClusterItems([]);
    setClusterError(null);

    setSelected(item);
    setPreviewOpen(true);
    zoomTo(item.latitude, item.longitude, 0.45);
  }

  function selectSearchResult(r: SearchResult) {
    const name = (r.title || r.name || "").trim();
    if (!name) return;

    let lat: number | null = safeNum((r as any).lat);
    let lng: number | null = safeNum((r as any).lng);

    if (lat == null || lng == null) {
      if (coordMode === "burial") {
        lat = safeNum(r.burial_latitude);
        lng = safeNum(r.burial_longitude);
        if (lat == null || lng == null) {
          lat = safeNum(r.death_latitude);
          lng = safeNum(r.death_longitude);
        }
      } else {
        lat = safeNum(r.death_latitude);
        lng = safeNum(r.death_longitude);
        if (lat == null || lng == null) {
          lat = safeNum(r.burial_latitude);
          lng = safeNum(r.burial_longitude);
        }
      }
    }

    if (lat == null || lng == null) return;

    setSearchOpen(false);

    const asPoint: DeathLocation = {
      id: String(r.id),
      name,
      latitude: lat,
      longitude: lng,
      place_name: undefined,
      category: undefined,
      death_date: undefined,
      wikipedia_url: r.wikipedia_url ?? undefined,
      source_url: r.source_url ?? undefined,
      source_urls: Array.isArray(r.source_urls) ? r.source_urls.filter(Boolean) : undefined,
      burial_latitude: safeNum(r.burial_latitude) ?? undefined,
      burial_longitude: safeNum(r.burial_longitude) ?? undefined,
      burial_place_name: undefined,
    };

    setSelected(asPoint);
    setPreviewOpen(true);

    mapRef.current?.animateToRegion(
      { latitude: lat, longitude: lng, latitudeDelta: 0.35, longitudeDelta: 0.35 },
      350
    );
  }



  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <View style={styles.container}>
        <MapView
          ref={(r) => (mapRef.current = r)}
          style={styles.map}
          region={region}
          onRegionChangeComplete={(r) => {
            const latMove = Math.abs(r.latitude - region.latitude);
            const lngMove = Math.abs(r.longitude - region.longitude);
            const zoomMove = Math.abs(r.longitudeDelta - region.longitudeDelta);
            if (latMove < 0.002 && lngMove < 0.002 && zoomMove < 0.002) return;
            setRegion(r);
          }}
          showsUserLocation
          showsMyLocationButton
          moveOnMarkerPress={false}
          onPress={() => {
            if (previewOpen) setPreviewOpen(false);
            setSelected(null);

            if (clusterOpen) setClusterOpen(false);
            setSearchOpen(false);
          }}
        >
          {renderMarkers ? (
  <>
    {points.map((p) => {
      const isSelectedPin =
        !!selected &&
        !selected.is_cluster &&
        !p.is_cluster &&
        (p.id === selected.id ||
          (p.latitude === selected.latitude && p.longitude === selected.longitude));

      const color = isSelectedPin ? pinColorSelected : pinColor;

      return (
        <Marker
          key={`${p.id}-${p.latitude}-${p.longitude}`}
          coordinate={{ latitude: p.latitude, longitude: p.longitude }}
          onPress={(e) => {
            (e as any)?.stopPropagation?.();
            onPressMarker(p);
          }}
          tracksViewChanges={false}
          anchor={{ x: 0.5, y: 1 }}
        >
          {p.is_cluster ? (
            <View style={styles.pinWrap}>
              <View style={styles.pinShadow} />
              <View style={[styles.pinBody, { backgroundColor: pinColor }]}>
                <View style={styles.pinInnerCircle}>
                  <Text style={styles.clusterCountText}>{p.count ?? ""}</Text>
                </View>
              </View>
              <View style={[styles.pinTip, { borderTopColor: pinColor }]} />
            </View>
          ) : (
            <View style={styles.pinWrap}>
              <View style={styles.pinShadow} />
              <View style={[styles.pinBody, { backgroundColor: color }]}>
                <View style={styles.pinInnerCircle} />
              </View>
              <View style={[styles.pinTip, { borderTopColor: color }]} />
            </View>
          )}
        </Marker>
      );
    })}
  </>
) : null}

        </MapView>

        {/* Top overlay */}
        <View style={styles.topOverlay}>
          <Text style={styles.appTitle}>Death Atlas</Text>

          <View style={styles.searchRow}>
            <View style={{ flex: 1 }}>
              <TextInput
                value={query}
                onChangeText={(t) => {
                  setQuery(t);
                  setSearchOpen(true);
                }}
                placeholder="Search"
                placeholderTextColor="rgba(255,255,255,0.55)"
                style={styles.searchInput}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
                onFocus={() => setSearchOpen(true)}
              />

              {/* dropdown */}
              {searchOpen && (query.trim().length >= 2 || searchLoading || !!searchError) ? (
                <View style={styles.dropdown}>
                  {searchLoading ? (
                    <View style={styles.dropdownRow}>
                      <ActivityIndicator />
                      <Text style={styles.dropdownMuted}> Searching…</Text>
                    </View>
                  ) : searchError ? (
                    <Text style={styles.dropdownError}>{searchError}</Text>
                  ) : searchResults.length === 0 ? (
                    <Text style={styles.dropdownMuted}>No results.</Text>
                  ) : (
                    searchResults.map((r) => (
                      <Pressable
                        key={`sr-${r.id}`}
                        onPress={() => selectSearchResult(r)}
                        style={({ pressed }) => [styles.dropdownItem, pressed && { opacity: 0.85 }]}
                      >
                        <Text style={styles.dropdownTitle} numberOfLines={1}>
                          {(r.title || r.name || "Unknown").trim()}
                        </Text>
                      </Pressable>
                    ))
                  )}
                </View>
              ) : null}
            </View>

            <View style={styles.modePillWrap}>
              <Pressable
                onPress={() => setCoordMode("death")}
                style={[
                  styles.modePill,
                  coordMode === "death" && styles.modePillActive,
                  coordMode === "death" && { backgroundColor: "rgba(120, 25, 25, 0.75)" },
                ]}
              >
                <Text style={[styles.modePillText, coordMode === "death" && styles.modePillTextActive]}>Death</Text>
              </Pressable>

              <Pressable
                onPress={() => setCoordMode("burial")}
                style={[
                  styles.modePill,
                  coordMode === "burial" && styles.modePillActive,
                  coordMode === "burial" && { backgroundColor: "rgba(37, 99, 235, 0.75)" },
                ]}
              >
                <Text style={[styles.modePillText, coordMode === "burial" && styles.modePillTextActive]}>Burial</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
            {CATEGORY_CHIPS.map((c) => {
              const active = selectedCategory === c.key;
              return (
                <Pressable
                  key={c.key}
                  onPress={() => setSelectedCategory(c.key)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{c.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.statusRow}>
            {loading ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <ActivityIndicator />
                <Text style={styles.statusText}>Loading…</Text>
              </View>
            ) : (
              <Text style={styles.statusText}>
                {points.length} pins • {coordMode === "burial" ? "Burial" : "Death"} mode
              </Text>
            )}
          </View>
        </View>

        {!!error ? <Text style={styles.errorBanner}>{error}</Text> : null}

        <LocationPreviewCard
          visible={previewOpen}
          item={selected}
          onClose={() => {
            setPreviewOpen(false);
            setSelected(null);
          }}
          onDirections={(it) => openDirections(it.latitude, it.longitude, it.name)}
        />

        {/* Cluster chooser modal */}
        <Modal visible={clusterOpen} transparent animationType="fade" onRequestClose={() => setClusterOpen(false)}>
          <Pressable style={styles.backdrop} onPress={() => setClusterOpen(false)} />
          <View style={styles.clusterWrap}>
            <View style={styles.clusterCard}>
              <View style={styles.clusterHeaderRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.clusterTitle}>{clusterTitle}</Text>
                  <Text style={styles.clusterSubtitle}>Choose a name to zoom in</Text>
                </View>

                <Pressable onPress={() => setClusterOpen(false)} style={styles.xBtn}>
                  <Text style={styles.xText}>✕</Text>
                </Pressable>
              </View>

              {clusterError ? (
                <Text style={styles.clusterErrorText}>{clusterError}</Text>
              ) : clusterItems.length === 0 ? (
                <Text style={styles.clusterEmptyText}>No names found for this coordinate.</Text>
              ) : (
                <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ paddingBottom: 6 }}>
                  {clusterItems.map((it) => (
                    <Pressable
                      key={`${it.id}-${it.latitude}-${it.longitude}`}
                      onPress={() => selectFromCluster(it)}
                      style={({ pressed }) => [styles.nameRow, pressed && styles.pressed]}
                    >
                      <Text style={styles.nameRowTitle} numberOfLines={1}>
                        {it.name}
                      </Text>
                      {!!it.place_name ? (
                        <Text style={styles.nameRowSub} numberOfLines={1}>
                          {it.place_name}
                        </Text>
                      ) : null}
                    </Pressable>
                  ))}
                </ScrollView>
              )}
            </View>
          </View>
        </Modal>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0b0c0f" },
  container: { flex: 1, backgroundColor: "#0b0c0f" },
  map: { flex: 1 },

  topOverlay: {
    position: "absolute",
    top: Platform.OS === "android" ? 14 : 8,
    left: 12,
    right: 12,
    borderRadius: 16,
    padding: 12,
    backgroundColor: "rgba(12, 14, 18, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    zIndex: 50,
  },
  appTitle: { color: "white", fontWeight: "900", fontSize: 18, marginBottom: 10 },

  searchRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  searchInput: {
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
    color: "rgba(255,255,255,0.92)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  dropdown: {
    marginTop: 6,
    borderRadius: 12,
    backgroundColor: "rgba(12, 14, 18, 0.96)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    overflow: "hidden",
  },
  dropdownRow: { padding: 10, flexDirection: "row", alignItems: "center" },
  dropdownMuted: { color: "rgba(255,255,255,0.70)", fontWeight: "800" },
  dropdownError: { padding: 10, color: "#fecaca", fontWeight: "900" },
  dropdownItem: { padding: 10, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.08)" },
  dropdownTitle: { color: "white", fontWeight: "900" },

  modePillWrap: {
    flexDirection: "row",
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  modePill: { paddingHorizontal: 12, paddingVertical: 10 },
  modePillActive: { backgroundColor: "rgba(120, 25, 25, 0.75)" },
  modePillText: { color: "rgba(255,255,255,0.75)", fontWeight: "900", fontSize: 12 },
  modePillTextActive: { color: "rgba(255,255,255,0.95)" },

  chipsRow: { paddingTop: 10, paddingBottom: 6, gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.45)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  chipActive: { backgroundColor: "rgba(120, 25, 25, 0.75)", borderColor: "rgba(255,255,255,0.18)" },
  chipText: { color: "rgba(255,255,255,0.78)", fontSize: 13, fontWeight: "900" },
  chipTextActive: { color: "rgba(255,255,255,0.95)" },

  statusRow: { marginTop: 6, minHeight: 18 },
  statusText: { color: "rgba(255,255,255,0.70)", fontSize: 12, fontWeight: "800" },

  errorBanner: {
    position: "absolute",
    top: Platform.OS === "android" ? 160 : 154,
    left: 12,
    right: 12,
    padding: 10,
    borderRadius: 14,
    backgroundColor: "rgba(120, 25, 25, 0.75)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    color: "white",
    fontWeight: "900",
  },

  // teardrop pins
  pinWrap: { alignItems: "center", justifyContent: "center" },
  pinShadow: {
    position: "absolute",
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(0,0,0,0.25)",
    transform: [{ translateY: 10 }],
  },
  pinBody: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#dc2626",
    alignItems: "center",
    justifyContent: "center",
  },
  pinInnerCircle: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "white",
  },
  pinTip: {
    width: 0,
    height: 0,
    marginTop: -2,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: 10,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: "#dc2626",
  },
  clusterCountText: {
    color: "#111827",
    fontWeight: "900",
    fontSize: 10,
    marginTop: -1.3,
    marginLeft: 1,
  },

  // cluster modal
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
  clusterWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: Platform.OS === "ios" ? 28 : 18,
    paddingHorizontal: 14,
  },
  clusterCard: {
    borderRadius: 18,
    padding: 14,
    backgroundColor: "rgba(12, 14, 18, 0.95)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  clusterHeaderRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  clusterTitle: { color: "white", fontWeight: "900", fontSize: 18 },
  clusterSubtitle: { color: "rgba(255,255,255,0.72)", marginTop: 6, fontWeight: "800" },

  xBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  xText: { color: "white", fontWeight: "900", fontSize: 14 },

  clusterErrorText: { marginTop: 14, color: "#fecaca", fontWeight: "900" },
  clusterEmptyText: { marginTop: 14, color: "rgba(255,255,255,0.72)", fontWeight: "800" },

  nameRow: {
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  nameRowTitle: { color: "white", fontWeight: "900" },
  nameRowSub: { marginTop: 4, color: "rgba(255,255,255,0.65)", fontWeight: "800", fontSize: 12 },
  pressed: { opacity: 0.85 },
});
