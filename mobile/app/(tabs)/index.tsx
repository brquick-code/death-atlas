import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import MapView, { Marker, Region } from "react-native-maps";
import { useRouter } from "expo-router";
import LocationPreviewCard from "../../components/LocationPreviewCard";

type DeathLocation = {
  id: string;
  name: string;

  latitude: number;
  longitude: number;

  place_name?: string;
  category?: string;
  death_date?: string;
  image_url?: string;

  wikipedia_url?: string;
  source_url?: string;

  confidence?: string;
  coord_source?: string;
};

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

export default function ExploreMapScreen() {
  const router = useRouter();
  const mapRef = useRef<MapView | null>(null);

  const [region, setRegion] = useState<Region>({
    latitude: 40.73061,
    longitude: -73.935242,
    latitudeDelta: 0.22,
    longitudeDelta: 0.22,
  });

  const [points, setPoints] = useState<DeathLocation[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [selected, setSelected] = useState<DeathLocation | null>(null);

  const apiBase = (process.env.EXPO_PUBLIC_API_BASE_URL || "").replace(/\/$/, "");

  const fetchUrl = useMemo(() => {
    if (!apiBase) return "";
    const { minLat, maxLat, minLng, maxLng } = regionToBbox(region);

    // 🔧 if your API differs, change only this line
    return `${apiBase}/api/death-locations?minLat=${minLat}&maxLat=${maxLat}&minLng=${minLng}&maxLng=${maxLng}&published=true`;
  }, [apiBase, region]);

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

        const res = await fetch(fetchUrl);
        if (!res.ok) throw new Error(`Fetch failed (${res.status})`);

        const data = await res.json();
        const rows: any[] = Array.isArray(data)
          ? data
          : Array.isArray(data?.points)
          ? data.points
          : [];

        const parsed: DeathLocation[] = rows
          .map((r) => {
            const lat = safeNum(r.latitude) ?? safeNum(r.death_latitude) ?? safeNum(r.lat);
            const lng = safeNum(r.longitude) ?? safeNum(r.death_longitude) ?? safeNum(r.lng);
            if (lat === null || lng === null) return null;

            return {
              id: String(r.id),
              name: String(r.name ?? r.full_name ?? r.title ?? "Unknown"),
              latitude: lat,
              longitude: lng,
              place_name: r.place_name ?? r.location_name ?? r.place ?? r.city_state ?? undefined,
              category: r.category ?? r.death_type ?? r.type ?? undefined,
              death_date: r.death_date ?? r.date ?? r.died_on ?? undefined,
              image_url: r.image_url ?? r.hero_image_url ?? r.image ?? undefined,
              wikipedia_url: r.wikipedia_url ?? r.wikipedia ?? undefined,
              source_url: r.source_url ?? r.source ?? undefined,
              confidence: r.confidence ?? undefined,
              coord_source: r.coord_source ?? undefined,
            } as DeathLocation;
          })
          .filter(Boolean) as DeathLocation[];

        if (!cancelled) {
          setPoints(parsed);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setLoading(false);
          setError(e?.message || "Fetch failed.");
        }
      }
    }

    t = setTimeout(run, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [fetchUrl]);

  // ✅ pin tap => popup only
  function onPressMarker(item: DeathLocation) {
    setSelected(item);
    setPreviewOpen(true);
  }

  function openDetails(item: DeathLocation) {
  console.log("LOCKDOWN openDetails called for:", item.id);
  setPreviewOpen(false);
  return; // 🚫 NO navigation allowed
}


  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <View style={styles.container}>
        <MapView
          ref={(r) => (mapRef.current = r)}
          style={styles.map}
          region={region}
          onRegionChangeComplete={(r) => setRegion(r)}
          showsUserLocation
          showsMyLocationButton
          moveOnMarkerPress={false}
          onPress={() => {
            if (previewOpen) setPreviewOpen(false);
          }}
        >
          {points.map((p) => (
            <Marker
              key={p.id}
              coordinate={{ latitude: p.latitude, longitude: p.longitude }}
              onPress={(e) => {
                (e as any)?.stopPropagation?.();
                onPressMarker(p);
              }}
              tracksViewChanges={false}
            />
          ))}
        </MapView>

        {/* Top overlay header like your screenshot */}
        <View style={styles.header}>
          <Text style={styles.headerLeft}>Death Atlas Mobile</Text>

          <View style={styles.headerRight}>
            {loading ? (
              <ActivityIndicator />
            ) : (
              <Text style={styles.headerRightText}>{points.length} pins</Text>
            )}
          </View>
        </View>

        {!!error ? <Text style={styles.errorBanner}>{error}</Text> : null}

        {/* Bottom popup */}
        <LocationPreviewCard
          visible={previewOpen}
          item={selected}
          onClose={() => setPreviewOpen(false)}
          onOpenDetails={(it) => openDetails(it as any)}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0b0c0f" },
  container: { flex: 1, backgroundColor: "#0b0c0f" },
  map: { flex: 1 },

  header: {
    position: "absolute",
    top: Platform.OS === "android" ? 14 : 8,
    left: 12,
    right: 12,
    height: 44,
    borderRadius: 14,
    paddingHorizontal: 14,
    backgroundColor: "rgba(12, 14, 18, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: {
    color: "white",
    fontWeight: "900",
    fontSize: 16,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerRightText: {
    color: "rgba(255,255,255,0.85)",
    fontWeight: "800",
    fontSize: 13,
  },

  errorBanner: {
    position: "absolute",
    top: Platform.OS === "android" ? 64 : 58,
    left: 12,
    right: 12,
    padding: 10,
    borderRadius: 14,
    backgroundColor: "rgba(120, 25, 25, 0.75)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    color: "white",
    fontWeight: "800",
  },
});
