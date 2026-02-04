import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  ImageBackground,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

type DeathLocation = {
  id: string;
  name: string;

  // optional metadata you may already have in your DB / API
  place_name?: string; // e.g. "The Dakota, New York, NY"
  category?: string; // e.g. "Assassination"
  death_date?: string; // e.g. "1980-12-08"
  summary?: string; // description paragraph

  // URLs
  wikipedia_url?: string;
  source_url?: string; // could be Wikipedia or other

  // for Directions
  latitude?: number;
  longitude?: number;

  // hero image
  image_url?: string; // best if you can provide a real image URL
};

function formatDate(dateStr?: string) {
  if (!dateStr) return "";
  // Accept "YYYY-MM-DD" or ISO
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function formatMeta(category?: string, dateStr?: string) {
  const c = category?.trim();
  const d = formatDate(dateStr);
  if (c && d) return `${c}  |  ${d}`;
  if (c) return c;
  if (d) return d;
  return "";
}

function buildMapsUrl(lat?: number, lng?: number, label?: string) {
  if (typeof lat !== "number" || typeof lng !== "number") return null;

  const encodedLabel = encodeURIComponent(label || "Location");
  if (Platform.OS === "ios") {
    // Apple Maps
    return `http://maps.apple.com/?ll=${lat},${lng}&q=${encodedLabel}`;
  }
  // Google Maps (Android)
  return `geo:${lat},${lng}?q=${lat},${lng}(${encodedLabel})`;
}

export default function LocationDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    id?: string;
    // Allow passing data straight in the route for instant rendering
    name?: string;
    place_name?: string;
    category?: string;
    death_date?: string;
    summary?: string;
    wikipedia_url?: string;
    source_url?: string;
    image_url?: string;
    latitude?: string;
    longitude?: string;
  }>();

  const id = (params.id ?? "").toString();

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<DeathLocation | null>(null);

  // If you navigated here with params (fast path), build a partial item immediately.
  const paramItem = useMemo<DeathLocation | null>(() => {
    if (!id) return null;

    const lat =
      params.latitude !== undefined ? Number(params.latitude) : undefined;
    const lng =
      params.longitude !== undefined ? Number(params.longitude) : undefined;

    const hasAnyParamData =
      params.name ||
      params.place_name ||
      params.category ||
      params.death_date ||
      params.summary ||
      params.wikipedia_url ||
      params.source_url ||
      params.image_url ||
      (params.latitude && params.longitude);

    if (!hasAnyParamData) return null;

    return {
      id,
      name: (params.name ?? "").toString() || "Unknown",
      place_name: params.place_name?.toString(),
      category: params.category?.toString(),
      death_date: params.death_date?.toString(),
      summary: params.summary?.toString(),
      wikipedia_url: params.wikipedia_url?.toString(),
      source_url: params.source_url?.toString(),
      image_url: params.image_url?.toString(),
      latitude: Number.isFinite(lat) ? lat : undefined,
      longitude: Number.isFinite(lng) ? lng : undefined,
    };
  }, [id, params]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!id) {
        setLoading(false);
        setError("Missing id.");
        return;
      }

      // Start with paramItem if available (so UI renders instantly)
      if (paramItem) {
        setItem(paramItem);
      }

      try {
        setLoading(true);
        setError(null);

        // ✅ Replace this URL with YOUR API route if different.
        // Example:
        // - Next.js API:   http://<your-ip>:3000/api/death-locations?id=<id>
        // - Expo dev:      process.env.EXPO_PUBLIC_API_BASE_URL + "/api/death-locations?id=" + id
        const base = process.env.EXPO_PUBLIC_API_BASE_URL || "";
        const url = base
          ? `${base.replace(/\/$/, "")}/api/death-locations?id=${encodeURIComponent(id)}`
          : "";

        if (!url) {
          // If no API base set, we just keep paramItem (or show error)
          if (!paramItem) {
            throw new Error(
              "No EXPO_PUBLIC_API_BASE_URL set. Either pass data via route params, or set the env var to your Next.js server."
            );
          }
          if (!cancelled) setLoading(false);
          return;
        }

        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to load (${res.status})`);
        }

        const data = (await res.json()) as any;

        // Expect either { item } or a direct item
        const raw: any = data?.item ?? data;

        const parsed: DeathLocation = {
          id: raw.id ?? id,
          name: raw.name ?? raw.full_name ?? raw.title ?? "Unknown",
          place_name:
            raw.place_name ??
            raw.location_name ??
            raw.place ??
            raw.city_state ??
            undefined,
          category: raw.category ?? raw.death_type ?? raw.type ?? undefined,
          death_date: raw.death_date ?? raw.date ?? raw.died_on ?? undefined,
          summary: raw.summary ?? raw.description ?? raw.blurb ?? undefined,
          wikipedia_url: raw.wikipedia_url ?? raw.wikipedia ?? undefined,
          source_url: raw.source_url ?? raw.source ?? undefined,
          image_url: raw.image_url ?? raw.image ?? raw.hero_image_url ?? undefined,
          latitude:
            typeof raw.latitude === "number"
              ? raw.latitude
              : typeof raw.death_latitude === "number"
              ? raw.death_latitude
              : undefined,
          longitude:
            typeof raw.longitude === "number"
              ? raw.longitude
              : typeof raw.death_longitude === "number"
              ? raw.death_longitude
              : undefined,
        };

        if (!cancelled) {
          setItem(parsed);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || "Failed to load.");
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [id, paramItem]);

  const title = item?.name ?? "Loading…";
  const subtitle =
    item?.place_name?.trim() ||
    "Location unknown";

  const meta = formatMeta(item?.category, item?.death_date);

  const heroUri =
    item?.image_url?.trim() ||
    // fallback: a moody dark placeholder (no network needed would be better, but keep simple)
    "https://images.unsplash.com/photo-1506377247377-2a5b3b417ebb?auto=format&fit=crop&w=1200&q=60";

  const directionsUrl = buildMapsUrl(item?.latitude, item?.longitude, item?.name);
  const wikipediaUrl = item?.wikipedia_url || (item?.source_url?.includes("wikipedia.org") ? item?.source_url : null);

  function openUrl(url: string) {
    Linking.openURL(url).catch(() => {});
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <View style={styles.container}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <ImageBackground source={{ uri: heroUri }} style={styles.hero} resizeMode="cover">
            {/* dark overlay */}
            <View style={styles.heroOverlay} />

            {/* top bar */}
            <View style={styles.topBar}>
              <Pressable
                onPress={() => {
  const canGoBack = typeof (router as any).canGoBack === "function" ? (router as any).canGoBack() : false;
  if (canGoBack) {
    router.back();
  } else {
    // ✅ fallback when opened from a tab with no stack history
    router.replace("/(tabs)");
  }
}}

                style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="Back"
              >
                <Text style={styles.iconText}>←</Text>
              </Pressable>
            </View>

            {/* bottom text block (like screenshot) */}
            <View style={styles.heroTextWrap}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.subtitle}>{subtitle}</Text>

              {meta ? (
                <View style={styles.metaRow}>
                  <Text style={styles.metaText}>{meta}</Text>
                </View>
              ) : null}

              <View style={styles.divider} />

              <Text style={styles.body}>
                {item?.summary?.trim() ||
                  "No summary available yet. Add a Wikipedia summary pass (or your own description) and it will appear here."}
              </Text>

              <View style={styles.actionsRow}>
                <Pressable
                  onPress={() => directionsUrl && openUrl(directionsUrl)}
                  disabled={!directionsUrl}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    (!directionsUrl || pressed) && styles.pressed,
                    !directionsUrl && styles.disabled,
                  ]}
                >
                  <Text style={styles.primaryBtnText}>Directions</Text>
                </Pressable>

                <Pressable
                  onPress={() => {
                    // "Learn More" could navigate to a deeper info screen later.
                    // For now: open the best URL we have.
                    const url = item?.source_url || wikipediaUrl;
                    if (url) openUrl(url);
                  }}
                  style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryBtnText}>Learn More</Text>
                </Pressable>
              </View>

              <Pressable
                onPress={() => wikipediaUrl && openUrl(wikipediaUrl)}
                disabled={!wikipediaUrl}
                style={({ pressed }) => [
                  styles.linkRow,
                  pressed && styles.pressed,
                  !wikipediaUrl && styles.disabled,
                ]}
              >
                <View style={styles.checkboxDot} />
                <Text style={styles.linkRowText}>Read on Wikipedia</Text>
                <Text style={styles.chev}>›</Text>
              </Pressable>

              {loading ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator />
                  <Text style={styles.loadingText}>Loading…</Text>
                </View>
              ) : null}

              {error ? (
                <Text style={styles.errorText}>{error}</Text>
              ) : null}
            </View>
          </ImageBackground>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0b0c0f",
  },
  container: {
    flex: 1,
    backgroundColor: "#0b0c0f",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  hero: {
    minHeight: 820,
    width: "100%",
    justifyContent: "flex-end",
    backgroundColor: "#0b0c0f",
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },

  topBar: {
    position: "absolute",
    top: 10,
    left: 14,
    right: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    zIndex: 3,
  },
  iconBtn: {
    height: 42,
    width: 42,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: {
    color: "white",
    fontSize: 20,
    fontWeight: "700",
    marginTop: -1,
  },

  heroTextWrap: {
    paddingHorizontal: 18,
    paddingBottom: 18,
    paddingTop: 120,
  },
  title: {
    color: "white",
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  subtitle: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 16,
    marginTop: 6,
  },
  metaRow: {
    marginTop: 10,
  },
  metaText: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 14,
    fontWeight: "600",
  },
  divider: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.18)",
    marginTop: 14,
    marginBottom: 14,
  },
  body: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 14,
    lineHeight: 20,
  },

  actionsRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
  primaryBtn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    backgroundColor: "#7a1f1f", // deep red like screenshot
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    color: "white",
    fontWeight: "800",
    fontSize: 14,
    letterSpacing: 0.3,
  },
  secondaryBtn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    color: "rgba(255,255,255,0.92)",
    fontWeight: "800",
    fontSize: 14,
    letterSpacing: 0.3,
  },

  linkRow: {
    marginTop: 12,
    height: 44,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.35)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
  },
  checkboxDot: {
    width: 16,
    height: 16,
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.18)",
    marginRight: 10,
  },
  linkRowText: {
    flex: 1,
    color: "rgba(255,255,255,0.92)",
    fontWeight: "700",
    fontSize: 14,
  },
  chev: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 22,
    marginTop: -2,
  },

  loadingRow: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  loadingText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
  },
  errorText: {
    marginTop: 10,
    color: "#ff8a8a",
    fontSize: 13,
    fontWeight: "600",
  },

  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.45,
  },
});
