// mobile/app/(tabs)/map.tsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as SplashScreen from "expo-splash-screen";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  Keyboard,
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
} from "react-native";
import MapView, { Marker, Region } from "react-native-maps";
import { useLocalSearchParams } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import LocationPreviewCard from "../../components/LocationPreviewCard";
import PremiumPaywallModal from "../../components/PremiumPaywallModal";
import { getOrFetch } from "../../lib/deathLocationsPrefetch";
import { usePremium } from "../../lib/premium";

type CoordMode = "death" | "burial" | "missing" | "disaster";

type CanonCategory = "Murder" | "Accident" | "Natural" | "Suicide";
type CategoryKey = "All" | CanonCategory;

type DeathLocation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;

  place_name?: string;
  category?: CanonCategory;
  death_date?: string;

  wikipedia_url?: string;
  source_url?: string;
  source_urls?: string[];

  burial_latitude?: number;
  burial_longitude?: number;
  burial_place_name?: string;

  missing_date?: string;
  missing_status?: string;

  is_cluster?: boolean;
  count?: number;
  members?: DeathLocation[];
};

type DisasterSite = {
  id: string;
  title: string;
  disaster_type: string;
  subtitle?: string | null;

  start_date?: string | null;
  end_date?: string | null;

  deaths_est?: number | null;
  deaths_min?: number | null;
  deaths_max?: number | null;

  latitude: number;
  longitude: number;

  radius_m?: number | null;
  location_name?: string | null;

  tags?: string[];
  sources?: any; // jsonb array: [{label,url},...]
};

type DisasterMarker = DisasterSite & {
  is_cluster?: boolean;
  count?: number;
  members?: DisasterSite[];
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

  missing_latitude?: number | null;
  missing_longitude?: number | null;
  missing_place_name?: string | null;
  missing_date?: string | null;
  missing_status?: string | null;

  wikipedia_url?: string | null;
  source_url?: string | null;
  source_urls?: string[] | null;

  lat?: number | null;
  lng?: number | null;
  coord_kind?: "death" | "burial" | "missing" | null;
};

const CATEGORY_CHIPS = [
  { key: "All", label: "All" },
  { key: "Murder", label: "Murder" },
  { key: "Accident", label: "Accident" },
  { key: "Natural", label: "Natural" },
  { key: "Suicide", label: "Suicide" },
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

function normalizeCategory(raw?: any): CanonCategory | null {
  const s = norm(typeof raw === "string" ? raw : raw?.toString?.());
  if (!s) return null;

  if (s === "murder") return "Murder";
  if (s === "accident") return "Accident";
  if (s === "natural") return "Natural";
  if (s === "suicide") return "Suicide";

  if (s.includes("murder") || s.includes("homicide") || s.includes("assassination") || s.includes("execution"))
    return "Murder";
  if (s.includes("suicide") || s.includes("self-harm") || s.includes("self harm")) return "Suicide";
  if (
    s.includes("accident") ||
    s.includes("accidental") ||
    s.includes("crash") ||
    s.includes("wreck") ||
    s.includes("drown") ||
    s.includes("overdose")
  )
    return "Accident";
  if (
    s.includes("natural") ||
    s.includes("illness") ||
    s.includes("disease") ||
    s.includes("heart") ||
    s.includes("stroke") ||
    s.includes("cancer")
  )
    return "Natural";

  return null;
}

function categoryMatches(loc: DeathLocation, selected: CategoryKey) {
  if (selected === "All") return true;
  return loc.category === selected;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function regionToBbox(region: Region) {
  const latDeltaRaw = region.latitudeDelta ?? 0.2;
  const lngDeltaRaw = region.longitudeDelta ?? 0.2;

  const latDelta = clamp(latDeltaRaw, 0.03, 180);
  const lngDelta = clamp(lngDeltaRaw, 0.03, 360);

  const minLat = region.latitude - latDelta / 2;
  const maxLat = region.latitude + latDelta / 2;
  const minLng = region.longitude - lngDelta / 2;
  const maxLng = region.longitude + lngDelta / 2;
  return { minLat, maxLat, minLng, maxLng };
}

function regionToPaddedBbox(region: Region, pad = 1.25) {
  const latDeltaRaw = region.latitudeDelta ?? 0.2;
  const lngDeltaRaw = region.longitudeDelta ?? 0.2;

  const latDelta = clamp(latDeltaRaw * pad, 0.03, 180);
  const lngDelta = clamp(lngDeltaRaw * pad, 0.03, 360);

  const minLat = region.latitude - latDelta / 2;
  const maxLat = region.latitude + latDelta / 2;
  const minLng = region.longitude - lngDelta / 2;
  const maxLng = region.longitude + lngDelta / 2;
  return { minLat, maxLat, minLng, maxLng };
}

function requestZoomFromRegion(_region: Region) {
  return 20;
}

function coordKey(lat: number, lng: number) {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

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
    const members = [...arr].sort((a, b) => (a.name || "").localeCompare(b.name || ""));

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

function clusterSameCoordsDisasters(items: DisasterSite[]): DisasterMarker[] {
  const buckets = new Map<string, DisasterSite[]>();

  for (const d of items) {
    const k = coordKey(d.latitude, d.longitude);
    const arr = buckets.get(k);
    if (arr) arr.push(d);
    else buckets.set(k, [d]);
  }

  const out: DisasterMarker[] = [];

  for (const [k, arr] of buckets.entries()) {
    if (arr.length === 1) {
      out.push(arr[0] as DisasterMarker);
      continue;
    }

    const first = arr[0];
    const members = [...arr].sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    out.push({
      ...(first as DisasterMarker),
      id: `dcluster-${k}`,
      title: `Cluster (${arr.length})`,
      is_cluster: true,
      count: arr.length,
      members,
    });
  }

  return out;
}

/**
 * Supports BOTH API shapes:
 * - old: death_latitude/death_longitude + burial_latitude/burial_longitude (+ missing_* once added)
 * - new: lat/lng + coord_kind
 */
function extractCoordsForMode(row: any, mode: Exclude<CoordMode, "disaster">): { lat: number; lng: number } | null {
  const apiLat = safeNum(row.lat) ?? safeNum(row.latitude);
  const apiLng = safeNum(row.lng) ?? safeNum(row.longitude);
  const kind = (row.coord_kind ?? row.coordKind ?? row.coord_kind) as "death" | "burial" | "missing" | undefined;

  if (apiLat != null && apiLng != null && (kind === "death" || kind === "burial" || kind === "missing")) {
    if (mode === kind) return { lat: apiLat, lng: apiLng };
    return null;
  }

  if (mode === "missing") {
    const lat = safeNum(row.missing_latitude);
    const lng = safeNum(row.missing_longitude);
    if (lat === null || lng === null) return null;
    return { lat, lng };
  }

  if (mode === "burial") {
    const lat = safeNum(row.burial_latitude);
    const lng = safeNum(row.burial_longitude);
    if (lat === null || lng === null) return null;
    return { lat, lng };
  }

  const lat = safeNum(row.death_latitude) ?? safeNum(row.latitude) ?? safeNum(row.lat);
  const lng = safeNum(row.death_longitude) ?? safeNum(row.longitude) ?? safeNum(row.lng) ?? safeNum(row.lon);

  if (lat === null || lng === null) return null;
  return { lat, lng };
}

async function openDirections(lat: number, lng: number, label?: string) {
  const qLabel = (label || "Destination").trim();

  const apple = `http://maps.apple.com/?daddr=${encodeURIComponent(`${lat},${lng}`)}&q=${encodeURIComponent(qLabel)}`;
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

function formatPurchaseHelpMessage(errMessage?: string) {
  const extra =
    "\n\nIf you’re testing subscriptions:\n" +
    "• Make sure the subscription product exists in App Store Connect.\n" +
    "• Make sure you’re signed into a Sandbox tester on the device (Settings → App Store → Sandbox Account).\n" +
    "• If products aren’t returned yet, Apple sometimes needs a bit after creation.";
  return (errMessage ? `${errMessage}` : "Purchase failed.") + extra;
}

function parseDisasterRows(rows: any[]): DisasterSite[] {
  return rows
    .map((r) => {
      const lat = safeNum(r.latitude) ?? safeNum(r.lat);
      const lng = safeNum(r.longitude) ?? safeNum(r.lng);
      if (lat == null || lng == null) return null;

      const title =
        firstNonEmpty(r.title, r.name, r.label, r.display_name, r.event_name, r.disaster_name, r.headline) ?? "";
      if (!title.trim()) return null;

      const idStr = firstNonEmpty(r.id, r.site_id, r.disaster_id, r.slug) ?? `${title}-${lat}-${lng}`;

      return {
        id: String(idStr),
        title: String(title),
        disaster_type: String(firstNonEmpty(r.disaster_type, r.type, r.category) ?? "disaster"),
        subtitle: firstNonEmpty(r.subtitle, r.summary, r.subheading) ?? null,
        start_date: firstNonEmpty(r.start_date, r.startDate, r.date_start, r.date) ?? null,
        end_date: firstNonEmpty(r.end_date, r.endDate, r.date_end) ?? null,
        deaths_est: safeNum(r.deaths_est) ?? safeNum(r.deaths) ?? null,
        deaths_min: safeNum(r.deaths_min) ?? null,
        deaths_max: safeNum(r.deaths_max) ?? null,
        latitude: lat,
        longitude: lng,
        radius_m: safeNum(r.radius_m) ?? safeNum(r.radius) ?? null,
        location_name: firstNonEmpty(r.location_name, r.place_name, r.place, r.location) ?? null,
        tags: Array.isArray(r.tags) ? r.tags.filter(Boolean).map((x: any) => String(x)) : [],
        sources: r.sources ?? [],
      } as DisasterSite;
    })
    .filter(Boolean) as DisasterSite[];
}

function isPrivateDevBase(base: string) {
  const b = base.toLowerCase();
  return (
    b.startsWith("http://localhost") ||
    b.startsWith("http://127.0.0.1") ||
    b.startsWith("http://10.") ||
    b.startsWith("http://192.168.") ||
    /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\./.test(b)
  );
}

// ✅ Selected marker sizing (kept small so it doesn’t look goofy, but obvious in a crowd)
function markerScale(isSelected: boolean) {
  return isSelected ? 1.45 : 1;
}

export default function IndexMapScreen() {
  const mapRef = useRef<MapView | null>(null);
  const params = useLocalSearchParams<{
    focusLat?: string;
    focusLng?: string;
    focusMode?: CoordMode;
    focusName?: string;
  }>();

  const [region, setRegion] = useState<Region>({
    latitude: 39.5,
    longitude: -98.35,
    latitudeDelta: 18,
    longitudeDelta: 18,
  });

  const [coordMode, setCoordMode] = useState<CoordMode>("death");
  const [selectedCategory, setSelectedCategory] = useState<CategoryKey>("All");

  const [query, setQuery] = useState<string>("");
  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [searchLoading, setSearchLoading] = useState<boolean>(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [points, setPoints] = useState<DeathLocation[]>([]);
  const [disasters, setDisasters] = useState<DisasterMarker[]>([]);
  const disastersRawRef = useRef<DisasterSite[]>([]);

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [selected, setSelected] = useState<DeathLocation | null>(null);

  const [disasterPreviewOpen, setDisasterPreviewOpen] = useState(false);
  const [selectedDisaster, setSelectedDisaster] = useState<DisasterSite | null>(null);

  const [clusterOpen, setClusterOpen] = useState(false);
  const [clusterTitle, setClusterTitle] = useState<string>("Cluster");
  const [clusterItems, setClusterItems] = useState<DeathLocation[]>([]);
  const [clusterError, setClusterError] = useState<string | null>(null);

  // ✅ Disaster cluster picker modal
  const [disasterClusterOpen, setDisasterClusterOpen] = useState(false);
  const [disasterClusterTitle, setDisasterClusterTitle] = useState("Disaster Cluster");
  const [disasterClusterItems, setDisasterClusterItems] = useState<DisasterSite[]>([]);

  // ✅ Premium hook
  const { isPremium, startPurchase, restore } = usePremium();
  const [premiumOpen, setPremiumOpen] = useState(false);
  const lockSuffix = " 🔒";

  useFocusEffect(
    useCallback(() => {
      return () => {
        setPremiumOpen(false);
        setClusterOpen(false);
        setSearchOpen(false);
        setDisasterPreviewOpen(false);
        setDisasterClusterOpen(false);
        Keyboard.dismiss();
      };
    }, [])
  );

  useEffect(() => {
    if (isPremium && premiumOpen) setPremiumOpen(false);
  }, [isPremium, premiumOpen]);

  const launchTsRef = useRef<number>(Date.now());
  const [showFadeSplash, setShowFadeSplash] = useState(true);
  const splashOpacity = useRef(new Animated.Value(1)).current;
  const splashHideStartedRef = useRef(false);

  // ✅ HARD GUARD:
  // In preview/prod builds, never allow a LAN/localhost base to sneak in.
  const apiBase = useMemo(() => {
    const raw = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");
    const fallback = "https://death-atlas-web.vercel.app";
    const base = raw.length ? raw : fallback;

    if (!__DEV__ && isPrivateDevBase(base)) return fallback;
    return base;
  }, []);

  const isBurial = coordMode === "burial";
  const isMissing = coordMode === "missing";
  const isDisaster = coordMode === "disaster";

  const pinColor = isDisaster ? "#f59e0b" : isMissing ? "#16a34a" : isBurial ? "#2563eb" : "#dc2626";
  const pinColorSelected = isDisaster ? "#b45309" : isMissing ? "#166534" : isBurial ? "#1e3a8a" : "#991b1b";

  const fetchSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastGoodPointsRef = useRef<DeathLocation[]>([]);
  const lastGoodDisastersRef = useRef<DisasterMarker[]>([]);
  const rerenderTimerRef = useRef<any>(null);

  const [trackingIds, setTrackingIds] = useState<Set<string>>(new Set());
  const trackingClearTimerRef = useRef<any>(null);

  // People cache
  const cacheRef = useRef<Map<string, DeathLocation>>(new Map());
  const cacheOrderRef = useRef<string[]>([]);
  const MAX_CACHE = 6000;

  function cacheReset() {
    cacheRef.current = new Map();
    cacheOrderRef.current = [];
  }

  function cacheUpsertMany(items: DeathLocation[]) {
    for (const p of items) {
      if ((p as any).is_cluster) continue;

      const id = p.id;
      const exists = cacheRef.current.has(id);
      cacheRef.current.set(id, p);

      if (!exists) {
        cacheOrderRef.current.push(id);
      }
    }

    if (cacheOrderRef.current.length > MAX_CACHE) {
      const overflow = cacheOrderRef.current.length - MAX_CACHE;
      const toDrop = cacheOrderRef.current.splice(0, overflow);
      for (const id of toDrop) cacheRef.current.delete(id);
    }
  }

  function kickMarkerTracking(ids: string[], ms = 520) {
    if (Platform.OS !== "android") return;

    setTrackingIds(new Set(ids));

    if (trackingClearTimerRef.current) clearTimeout(trackingClearTimerRef.current);
    trackingClearTimerRef.current = setTimeout(() => {
      setTrackingIds(new Set());
    }, ms);
  }

  function requirePremium(action: () => void) {
    if (isPremium) return action();
    setPremiumOpen(true);
  }

  function setCoordModeGated(next: CoordMode) {
    if (next === "death") {
      setCoordMode("death");
      return;
    }
    requirePremium(() => setCoordMode(next));
  }

  useEffect(() => {
    if (!isPremium && selectedCategory !== "All") {
      setSelectedCategory("All");
    }
  }, [isPremium, selectedCategory]);

  useEffect(() => {
    if (coordMode === "missing") setSelectedCategory("All");
    if (coordMode === "disaster") setSelectedCategory("All");
  }, [coordMode]);

  useEffect(() => {
    setPreviewOpen(false);
    setSelected(null);

    setDisasterPreviewOpen(false);
    setSelectedDisaster(null);

    setClusterOpen(false);
    setClusterItems([]);
    setClusterError(null);

    setDisasterClusterOpen(false);
    setDisasterClusterItems([]);

    setLoading(true);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordMode]);

  useEffect(() => {
    const lat = params.focusLat ? Number(params.focusLat) : NaN;
    const lng = params.focusLng ? Number(params.focusLng) : NaN;
    const mode = params.focusMode;
    const name = (params.focusName || "").toString().trim();

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    if (!isPremium && (mode === "burial" || mode === "missing" || mode === "disaster")) {
      setCoordMode("death");
      setPremiumOpen(true);
      return;
    }

    if (mode === "death" || mode === "burial" || mode === "missing" || mode === "disaster") {
      setCoordMode(mode);
    }

    setSearchOpen(false);
    Keyboard.dismiss();
    setClusterOpen(false);
    setPreviewOpen(false);
    setSelected(null);

    setDisasterPreviewOpen(false);
    setSelectedDisaster(null);

    setDisasterClusterOpen(false);
    setDisasterClusterItems([]);

    const next: Region = {
      latitude: lat,
      longitude: lng,
      latitudeDelta: 0.35,
      longitudeDelta: 0.35,
    };
    setRegion(next);

    requestAnimationFrame(() => {
      mapRef.current?.animateToRegion(next, 450);
    });

    if (mode === "disaster") {
      const syntheticDisaster: DisasterSite = {
        id: `focus-disaster-${name || "point"}-${lat}-${lng}`,
        title: name || "Disaster",
        disaster_type: "disaster",
        latitude: lat,
        longitude: lng,
        deaths_est: null,
        deaths_min: null,
        deaths_max: null,
      };

      setSelectedDisaster(syntheticDisaster);
      setDisasterPreviewOpen(true);
    } else {
      const synthetic: DeathLocation = {
        id: `focus-${name || "point"}-${lat}-${lng}`,
        name: name || "Selected",
        latitude: lat,
        longitude: lng,
      };

      setSelected(synthetic);
      setPreviewOpen(true);
    }
  }, [params.focusLat, params.focusLng, params.focusMode, params.focusName, isPremium]);

  const fetchUrl = useMemo(() => {
    const { minLat, maxLat, minLng, maxLng } = regionToBbox(region);
    const zoom = requestZoomFromRegion(region);

    const coordParam = coordMode === "disaster" ? "death" : coordMode;

    return (
      `${apiBase}/api/death-locations` +
      `?minLat=${encodeURIComponent(minLat)}` +
      `&minLng=${encodeURIComponent(minLng)}` +
      `&maxLat=${encodeURIComponent(maxLat)}` +
      `&maxLng=${encodeURIComponent(maxLng)}` +
      `&zoom=${encodeURIComponent(zoom)}` +
      `&coord=${encodeURIComponent(coordParam)}` +
      `&published=true`
    );
  }, [apiBase, region, coordMode]);

  const disastersFetchUrl = useMemo(() => {
    const { minLat, maxLat, minLng, maxLng } = regionToBbox(region);
    const limit = 2000;

    return (
      `${apiBase}/api/disasters` +
      `?minLat=${encodeURIComponent(minLat)}` +
      `&minLng=${encodeURIComponent(minLng)}` +
      `&maxLat=${encodeURIComponent(maxLat)}` +
      `&maxLng=${encodeURIComponent(maxLng)}` +
      `&limit=${encodeURIComponent(limit)}`
    );
  }, [apiBase, region]);

  function parseRows(rows: any[], mode: Exclude<CoordMode, "disaster">): DeathLocation[] {
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
            : mode === "missing"
            ? firstNonEmpty(r.missing_place_name, r.place_name, r.location_name, r.place, r.city_state, r.city, r.state)
            : firstNonEmpty(r.place_name, r.location_name, r.place, r.death_place, r.city_state, r.city, r.state);

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
          firstNonEmpty(r.id, r.anyId, r.wikidata_id, r.wikidataId, r.wd_id, r.slug, r.person_id, r.location_id) ??
          `${nameStr}-${coords.lat}-${coords.lng}`;

        const normalizedCat =
          normalizeCategory(r.category) ?? normalizeCategory(r.death_type) ?? normalizeCategory(r.type) ?? null;

        return {
          id: String(idStr),
          name: String(nameStr),
          latitude: coords.lat,
          longitude: coords.lng,
          place_name: placeStr,
          category: normalizedCat ?? undefined,
          death_date: firstNonEmpty(r.death_date, r.date, r.died_on, r.date_end),
          wikipedia_url: firstNonEmpty(r.wikipedia_url, r.wikipedia),
          source_url: firstNonEmpty(r.source_url, r.source),
          source_urls: Array.isArray(r.source_urls) ? r.source_urls.filter(Boolean).map((x: any) => String(x)) : undefined,
          burial_latitude: safeNum(r.burial_latitude) ?? undefined,
          burial_longitude: safeNum(r.burial_longitude) ?? undefined,
          burial_place_name: firstNonEmpty(r.burial_place_name),
          missing_date: firstNonEmpty(r.missing_date),
          missing_status: firstNonEmpty(r.missing_status),
        } as DeathLocation;
      })
      .filter(Boolean) as DeathLocation[];
  }

  function ensureSelectedIncluded(list: DeathLocation[]) {
    if (!selected) return list;
    const exists = list.some((p) => p.id === selected.id);
    if (exists) return list;
    if ((selected as any).is_cluster) return list;
    return [selected, ...list];
  }

  function computeVisibleFromCache(): DeathLocation[] {
    const { minLat, maxLat, minLng, maxLng } = regionToPaddedBbox(region, 1.35);

    const all = Array.from(cacheRef.current.values());
    const inView = all.filter((p) => {
      if (p.latitude < minLat || p.latitude > maxLat) return false;
      if (p.longitude < minLng || p.longitude > maxLng) return false;
      return true;
    });

    const q = norm(query);

    const filtered = inView.filter((p) => {
      if (coordMode !== "missing") {
        if (selectedCategory !== "All" && !isPremium) return false;
        if (!categoryMatches(p, selectedCategory)) return false;
        if (selectedCategory !== "All" && !p.category) return false;
      }

      if (!q) return true;
      const n = norm(p.name);
      const pl = norm(p.place_name);
      const bp = norm(p.burial_place_name);
      return n.includes(q) || pl.includes(q) || bp.includes(q);
    });

    const clustered = clusterSameCoords(filtered);

    const isFiltering = (coordMode !== "missing" && selectedCategory !== "All") || norm(query).length > 0;

    const base =
      clustered.length > 0
        ? clustered
        : !isFiltering && lastGoodPointsRef.current.length > 0
        ? lastGoodPointsRef.current
        : clustered;

    const next = ensureSelectedIncluded(base);

    if (!isFiltering && clustered.length > 0) lastGoodPointsRef.current = clustered;

    return next;
  }

  function computeVisibleDisasters(allRows: DisasterSite[]): DisasterMarker[] {
    const { minLat, maxLat, minLng, maxLng } = regionToPaddedBbox(region, 1.35);

    const inView = allRows.filter((d) => {
      if (d.latitude < minLat || d.latitude > maxLat) return false;
      if (d.longitude < minLng || d.longitude > maxLng) return false;
      return true;
    });

    const q = norm(query);
    const filtered = inView.filter((d) => {
      if (!q) return true;
      const t = norm(d.title);
      const loc = norm(d.location_name ?? "");
      const typ = norm(d.disaster_type ?? "");
      const sub = norm(d.subtitle ?? "");
      return t.includes(q) || loc.includes(q) || typ.includes(q) || sub.includes(q);
    });

    const clustered = clusterSameCoordsDisasters(filtered);

    const base =
      clustered.length > 0
        ? clustered
        : lastGoodDisastersRef.current.length > 0
        ? lastGoodDisastersRef.current
        : clustered;

    if (clustered.length > 0) lastGoodDisastersRef.current = clustered;

    return base;
  }

  // ✅ Fetch: people OR disasters
  useEffect(() => {
    let cancelled = false;
    let t: any;

    async function run() {
      const mySeq = ++fetchSeqRef.current;

      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {}
      }
      const ac = new AbortController();
      abortRef.current = ac;

      try {
        setLoading(true);
        setError(null);

        // ✅ DISASTERS MODE
        if (coordMode === "disaster") {
          const url = disastersFetchUrl;

          const res = await fetch(url, {
            signal: ac.signal,
            headers: { Accept: "application/json" },
          });

          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`Disasters fetch failed (${res.status}) URL=${url} BODY=${txt.slice(0, 140)}`.trim());
          }

          const ct = res.headers.get("content-type") ?? "";
          if (!ct.toLowerCase().includes("application/json")) {
            const txt = await res.text().catch(() => "");
            throw new Error(`Disasters non-JSON response URL=${url} CT=${ct} BODY=${txt.slice(0, 140)}`.trim());
          }

          const json = await res.json();
          if (cancelled || mySeq !== fetchSeqRef.current) return;

          const rows: any[] = Array.isArray(json?.rows) ? json.rows : Array.isArray(json) ? json : [];
          const parsed = parseDisasterRows(rows);

          disastersRawRef.current = parsed;

          const visible = computeVisibleDisasters(parsed);

          if (!cancelled) {
            setDisasters(visible);
            setLoading(false);
            kickMarkerTracking(visible.map((d) => `d:${d.id}`), 520);
          }
          return;
        }

        // ✅ PEOPLE MODE
        const data = await getOrFetch(fetchUrl, async () => {
          const res = await fetch(fetchUrl, { signal: ac.signal });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`Fetch failed (${res.status}) ${txt}`.trim());
          }
          return res.json();
        });

        if (cancelled || mySeq !== fetchSeqRef.current) return;

        const rows: any[] = Array.isArray(data)
          ? data
          : Array.isArray((data as any)?.points)
          ? (data as any).points
          : [];

        const parsed = parseRows(rows, coordMode as Exclude<CoordMode, "disaster">);

        cacheUpsertMany(parsed);

        const next = computeVisibleFromCache();

        if (!cancelled) {
          setPoints(next);
          setLoading(false);
          kickMarkerTracking(next.map((p) => `p:${p.id}`), 520);
        }
      } catch (e: any) {
        if (cancelled) return;
        if (e?.name === "AbortError") return;

        setLoading(false);
        setError(e?.message || "Fetch failed.");

        if (coordMode === "disaster") {
          kickMarkerTracking(disasters.map((d) => `d:${d.id}`), 420);
        } else {
          kickMarkerTracking(points.map((p) => `p:${p.id}`), 420);
        }
      }
    }

    t = setTimeout(run, 240);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchUrl, coordMode, disastersFetchUrl]);

  // ✅ Recompute visible list when region/query/category changes
  useEffect(() => {
    if (coordMode === "disaster") {
      const all = disastersRawRef.current;
      const visible = computeVisibleDisasters(all);
      setDisasters(visible);

      if (Platform.OS === "android") {
        if (rerenderTimerRef.current) clearTimeout(rerenderTimerRef.current);
        rerenderTimerRef.current = setTimeout(() => {
          kickMarkerTracking(visible.map((d) => `d:${d.id}`), 420);
        }, 120);
      }
      return;
    }

    const next = computeVisibleFromCache();
    setPoints(next);

    if (Platform.OS === "android") {
      if (rerenderTimerRef.current) clearTimeout(rerenderTimerRef.current);
      rerenderTimerRef.current = setTimeout(() => {
        kickMarkerTracking(next.map((p) => `p:${p.id}`), 420);
      }, 120);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, selectedCategory, query, isPremium, selected?.id, coordMode]);

  // Splash hide
  useEffect(() => {
    if (splashHideStartedRef.current) return;
    if (loading) return;

    splashHideStartedRef.current = true;
    let alive = true;

    (async () => {
      const elapsed = Date.now() - launchTsRef.current;
      const remaining = Math.max(0, 5000 - elapsed);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      if (!alive) return;

      try {
        await SplashScreen.hideAsync();
      } catch {}

      if (!alive) return;

      Animated.timing(splashOpacity, {
        toValue: 0,
        duration: 450,
        useNativeDriver: true,
      }).start(() => {
        if (!alive) return;
        setShowFadeSplash(false);
      });
    })();

    return () => {
      alive = false;
    };
  }, [loading, splashOpacity]);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      if (!alive) return;
      if (!showFadeSplash) return;

      (async () => {
        try {
          await SplashScreen.hideAsync();
        } catch {}
        Animated.timing(splashOpacity, {
          toValue: 0,
          duration: 450,
          useNativeDriver: true,
        }).start(() => {
          if (!alive) return;
          setShowFadeSplash(false);
        });
      })();
    }, 12000);

    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [showFadeSplash, splashOpacity]);

  // Search API: only for people modes
  useEffect(() => {
    if (coordMode === "disaster") {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }

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

      try {
        setSearchLoading(true);
        setSearchError(null);

        const url = `${apiBase}/api/search?q=${encodeURIComponent(q)}&limit=12&coord=${encodeURIComponent(coordMode)}`;
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

  function onPressDisaster(d: DisasterSite) {
    setClusterOpen(false);
    setClusterItems([]);
    setClusterError(null);

    setDisasterClusterOpen(false);
    setDisasterClusterItems([]);

    setPreviewOpen(false);
    setSelected(null);

    setSelectedDisaster(d);
    setDisasterPreviewOpen(true);
    zoomTo(d.latitude, d.longitude, 0.6);
  }

  function onPressDisasterMarker(d: DisasterMarker) {
    if (d.is_cluster) {
      const members = d.members ?? [];
      setDisasterPreviewOpen(false);
      setSelectedDisaster(null);

      setDisasterClusterTitle(d.count ? `Cluster (${d.count})` : "Disaster Cluster");
      setDisasterClusterItems(members);
      setDisasterClusterOpen(true);

      zoomTo(d.latitude, d.longitude, 0.6);
      return;
    }

    onPressDisaster(d);
  }

  function selectFromCluster(item: DeathLocation) {
    setClusterOpen(false);
    setClusterItems([]);
    setClusterError(null);

    setSelected(item);
    setPreviewOpen(true);
    zoomTo(item.latitude, item.longitude, 0.45);
  }

  function selectFromDisasterCluster(d: DisasterSite) {
    setDisasterClusterOpen(false);
    setDisasterClusterItems([]);
    onPressDisaster(d);
  }

  function selectSearchResult(r: SearchResult) {
    const name = (r.title || r.name || "").trim();
    if (!name) return;

    if (!isPremium && (coordMode === "burial" || coordMode === "missing")) {
      setPremiumOpen(true);
      return;
    }

    let lat: number | null = safeNum((r as any).lat);
    let lng: number | null = safeNum((r as any).lng);

    if (lat == null || lng == null) {
      if (coordMode === "missing") {
        lat = safeNum((r as any).missing_latitude);
        lng = safeNum((r as any).missing_longitude);
        if (lat == null || lng == null) {
          lat = safeNum(r.death_latitude) ?? safeNum(r.burial_latitude);
          lng = safeNum(r.death_longitude) ?? safeNum(r.burial_longitude);
        }
      } else if (coordMode === "burial") {
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

    const nextRegion: Region = {
      latitude: lat,
      longitude: lng,
      latitudeDelta: 0.35,
      longitudeDelta: 0.35,
    };
    setRegion(nextRegion);

    setSearchOpen(false);
    Keyboard.dismiss();

    const asPoint: DeathLocation = {
      id: String(r.id),
      name,
      latitude: lat,
      longitude: lng,
      place_name: coordMode === "missing" ? (r.missing_place_name ?? undefined) : undefined,
      category: normalizeCategory(r.category ?? undefined) ?? undefined,
      death_date: r.death_date ?? undefined,
      wikipedia_url: r.wikipedia_url ?? undefined,
      source_url: r.source_url ?? undefined,
      source_urls: Array.isArray(r.source_urls) ? r.source_urls.filter(Boolean) : undefined,
      burial_latitude: safeNum(r.burial_latitude) ?? undefined,
      burial_longitude: safeNum(r.burial_longitude) ?? undefined,
      burial_place_name: r.burial_place_name ?? undefined,
      missing_date: (r.missing_date as any) ?? undefined,
      missing_status: (r.missing_status as any) ?? undefined,
    };

    cacheUpsertMany([asPoint]);

    setSelected(asPoint);
    setPreviewOpen(true);

    mapRef.current?.animateToRegion(nextRegion, 350);

    kickMarkerTracking(points.map((p) => `p:${p.id}`).concat([`p:${asPoint.id}`]), 520);
  }

  function resolveDirectionsTarget(it: DeathLocation) {
    if (coordMode === "burial") {
      const bl = safeNum(it.burial_latitude);
      const bo = safeNum(it.burial_longitude);
      if (bl != null && bo != null) return { lat: bl, lng: bo };
    }
    return { lat: it.latitude, lng: it.longitude };
  }

  function onPressCategoryChip(key: CategoryKey) {
    if (key === "All") {
      setSelectedCategory("All");
      return;
    }
    if (!isPremium) {
      setPremiumOpen(true);
      return;
    }
    setSelectedCategory(key);
  }

  async function handleStartTrial() {
    try {
      await Promise.resolve(startPurchase());
      if (!isPremium) {
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : undefined;
      Alert.alert("Couldn’t start subscription", formatPurchaseHelpMessage(msg));
      throw e;
    }
  }

  async function handleRestorePurchases() {
    try {
      await Promise.resolve(restore());
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : undefined;
      Alert.alert("Restore failed", formatPurchaseHelpMessage(msg));
      throw e;
    }
  }

  function onRegionChangeCompleteStable(r: Region) {
    const latMove = Math.abs(r.latitude - region.latitude);
    const lngMove = Math.abs(r.longitude - region.longitude);
    const zoomMove = Math.abs(r.longitudeDelta - region.longitudeDelta);
    if (latMove < 0.002 && lngMove < 0.002 && zoomMove < 0.002) return;

    setRegion(r);

    if (Platform.OS === "android") {
      if (rerenderTimerRef.current) clearTimeout(rerenderTimerRef.current);
      rerenderTimerRef.current = setTimeout(() => {
        if (coordMode === "disaster") {
          kickMarkerTracking(disasters.map((d) => `d:${d.id}`), 520);
        } else {
          kickMarkerTracking(points.map((p) => `p:${p.id}`), 520);
        }
      }, 120);
    }
  }

  const visibleCount = coordMode === "disaster" ? disasters.length : points.length;

  // ✅ Debug stacking based on RAW disasters currently in view (pre-cluster)
  const disasterDebug = useMemo(() => {
    if (coordMode !== "disaster") return null;

    const all = disastersRawRef.current;
    const { minLat, maxLat, minLng, maxLng } = regionToPaddedBbox(region, 1.35);
    const inView = all.filter((d) => {
      if (d.latitude < minLat || d.latitude > maxLat) return false;
      if (d.longitude < minLng || d.longitude > maxLng) return false;
      return true;
    });

    const byCoord = new Map<string, number>();
    for (const d of inView) {
      const k = `${d.latitude.toFixed(5)},${d.longitude.toFixed(5)}`;
      byCoord.set(k, (byCoord.get(k) ?? 0) + 1);
    }

    const uniques = byCoord.size;
    const stacked = Array.from(byCoord.entries())
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1]);

    return { total: inView.length, uniques, stackedTop: stacked.slice(0, 5) };
  }, [coordMode, region]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <View style={styles.container}>
        <MapView
          ref={(r) => (mapRef.current = r)}
          style={styles.map}
          region={region}
          onRegionChangeComplete={onRegionChangeCompleteStable}
          showsUserLocation
          showsMyLocationButton
          moveOnMarkerPress={false}
        >
          {coordMode === "disaster"
            ? disasters.map((d) => {
                const isSelectedPin = !!selectedDisaster && !d.is_cluster && d.id === selectedDisaster.id;
                const color = isSelectedPin ? pinColorSelected : pinColor;
                const shouldTrack = Platform.OS === "android" ? trackingIds.has(`d:${d.id}`) : false;

                return (
                  <Marker
                    key={`d-${d.id}-${d.latitude}-${d.longitude}`}
                    coordinate={{ latitude: d.latitude, longitude: d.longitude }}
                    onPress={(e) => {
                      (e as any)?.stopPropagation?.();
                      onPressDisasterMarker(d);
                    }}
                    tracksViewChanges={shouldTrack}
                    anchor={{ x: 0.5, y: 1 }}
                    zIndex={isSelectedPin ? 999 : 1}
                  >
                    {d.is_cluster ? (
                      <View style={styles.pinWrap}>
                        <View style={styles.pinShadow} />
                        <View style={[styles.pinBody, { backgroundColor: pinColor }]}>
                          <View style={styles.pinInnerCircle}>
                            <Text style={styles.clusterCountText}>{d.count ?? ""}</Text>
                          </View>
                        </View>
                        <View style={[styles.pinTip, { borderTopColor: pinColor }]} />
                      </View>
                    ) : (
                      <View style={[styles.pinWrap, isSelectedPin && styles.pinWrapSelected, { transform: [{ scale: markerScale(isSelectedPin) }] }]}>
                        {isSelectedPin ? (
                          <View
                            pointerEvents="none"
                            style={[
                              styles.pinHalo,
                              { borderColor: color },
                            ]}
                          />
                        ) : null}

                        <View style={styles.pinShadow} />
                        <View style={[styles.pinBody, { backgroundColor: color }]}>
                          <View style={styles.pinInnerCircle}>
                            <Text style={styles.disasterBang}>!</Text>
                          </View>
                        </View>
                        <View style={[styles.pinTip, { borderTopColor: color }]} />
                      </View>
                    )}
                  </Marker>
                );
              })
            : points.map((p) => {
                const isSelectedPin =
                  !!selected &&
                  !selected.is_cluster &&
                  !p.is_cluster &&
                  (p.id === selected.id || (p.latitude === selected.latitude && p.longitude === selected.longitude));

                const color = isSelectedPin ? pinColorSelected : pinColor;
                const shouldTrack = Platform.OS === "android" ? trackingIds.has(`p:${p.id}`) : false;

                return (
                  <Marker
                    key={`${p.id}-${p.latitude}-${p.longitude}`}
                    coordinate={{ latitude: p.latitude, longitude: p.longitude }}
                    onPress={(e) => {
                      (e as any)?.stopPropagation?.();
                      onPressMarker(p);
                    }}
                    tracksViewChanges={shouldTrack}
                    anchor={{ x: 0.5, y: 1 }}
                    zIndex={isSelectedPin ? 999 : 1}
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
                      <View style={[styles.pinWrap, isSelectedPin && styles.pinWrapSelected, { transform: [{ scale: markerScale(isSelectedPin) }] }]}>
                        {isSelectedPin ? (
                          <View
                            pointerEvents="none"
                            style={[
                              styles.pinHalo,
                              { borderColor: color },
                            ]}
                          />
                        ) : null}

                        <View style={styles.pinShadow} />
                        <View style={[styles.pinBody, { backgroundColor: color }]}>
                          <View style={styles.pinInnerCirclePlain} />
                        </View>
                        <View style={[styles.pinTip, { borderTopColor: color }]} />
                      </View>
                    )}
                  </Marker>
                );
              })}
        </MapView>

        <View style={styles.topOverlay}>
          {/* ✅ Top line: Title + Search */}
          <View style={styles.titleSearchRow}>
            <Text style={styles.appTitle}>Death Atlas</Text>

            <View style={{ flex: 1 }}>
              <View style={styles.searchWrap}>
                <TextInput
                  value={query}
                  onChangeText={(t) => {
                    setQuery(t);
                    setSearchOpen(true);
                  }}
                  placeholder={coordMode === "disaster" ? "Search disasters" : "Search"}
                  placeholderTextColor="rgba(255,255,255,0.55)"
                  style={styles.searchInput}
                  autoCorrect={false}
                  autoCapitalize="none"
                  returnKeyType="search"
                  onFocus={() => setSearchOpen(true)}
                  onSubmitEditing={() => setSearchOpen(true)}
                />

                {query.length > 0 && (
                  <Pressable
                    onPress={() => {
                      setQuery("");
                      setSearchResults([]);
                      setSearchError(null);
                      setSearchLoading(false);
                      setSearchOpen(false);
                    }}
                    style={({ pressed }) => [styles.clearBtn, pressed && { opacity: 0.7 }]}
                    hitSlop={12}
                  >
                    <Text style={styles.clearBtnText}>✕</Text>
                  </Pressable>
                )}
              </View>

              {coordMode !== "disaster" && searchOpen && (query.trim().length >= 2 || searchLoading || !!searchError) ? (
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
          </View>

          {/* ✅ Second line: Mode pills stretched evenly */}
          <View style={styles.modePillWrap}>
            <Pressable
              onPress={() => setCoordModeGated("death")}
              style={[
                styles.modePill,
                coordMode === "death" && styles.modePillActive,
                coordMode === "death" && { backgroundColor: "rgba(120, 25, 25, 0.75)" },
              ]}
            >
              <Text style={[styles.modePillText, coordMode === "death" && styles.modePillTextActive]} numberOfLines={1}>
                Death
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setCoordModeGated("burial")}
              style={[
                styles.modePill,
                coordMode === "burial" && styles.modePillActive,
                coordMode === "burial" && { backgroundColor: "rgba(37, 99, 235, 0.75)" },
                !isPremium && styles.chipLocked,
              ]}
            >
              <Text
                style={[styles.modePillText, coordMode === "burial" && styles.modePillTextActive]}
                numberOfLines={1}
              >
                Burial{!isPremium ? lockSuffix : ""}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setCoordModeGated("missing")}
              style={[
                styles.modePill,
                coordMode === "missing" && styles.modePillActive,
                coordMode === "missing" && { backgroundColor: "rgba(22, 163, 74, 0.75)" },
                !isPremium && styles.chipLocked,
              ]}
            >
              <Text
                style={[styles.modePillText, coordMode === "missing" && styles.modePillTextActive]}
                numberOfLines={1}
              >
                Missing{!isPremium ? lockSuffix : ""}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setCoordModeGated("disaster")}
              style={[
                styles.modePill,
                coordMode === "disaster" && styles.modePillActive,
                coordMode === "disaster" && { backgroundColor: "rgba(245, 158, 11, 0.75)" },
                !isPremium && styles.chipLocked,
              ]}
            >
              <Text
                style={[styles.modePillText, coordMode === "disaster" && styles.modePillTextActive]}
                numberOfLines={1}
              >
                Disasters{!isPremium ? lockSuffix : ""}
              </Text>
            </Pressable>
          </View>

          {coordMode !== "missing" && coordMode !== "disaster" ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
              {CATEGORY_CHIPS.map((c) => {
                const active = selectedCategory === c.key;
                const locked = !isPremium && c.key !== "All";

                return (
                  <Pressable
                    key={c.key}
                    onPress={() => onPressCategoryChip(c.key)}
                    style={[styles.chip, active && !locked && styles.chipActive, locked && styles.chipLocked]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {c.label}
                      {locked ? " 🔒" : ""}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}

          <View style={styles.statusRow}>
            {loading ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <ActivityIndicator />
                <Text style={styles.statusText}>Loading…</Text>
              </View>
            ) : (
              <>
                <Text style={styles.statusText}>
                  {visibleCount} pins •{" "}
                  {coordMode === "burial"
                    ? "Burial"
                    : coordMode === "missing"
                    ? "Missing"
                    : coordMode === "disaster"
                    ? "Disasters"
                    : "Death"}{" "}
                  mode
                </Text>

                {coordMode === "disaster" && disasterDebug ? (
                  <Text style={styles.statusText}>
                    unique coords: {disasterDebug.uniques}
                    {disasterDebug.stackedTop.length ? ` • stacked: ${disasterDebug.stackedTop[0][1]}x` : ""}
                  </Text>
                ) : null}
              </>
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
          onDirections={(it) => {
            const t = resolveDirectionsTarget(it);
            requirePremium(() => {
              void openDirections(t.lat, t.lng, it.name);
            });
          }}
          isPremium={isPremium}
          onRequirePremium={() => setPremiumOpen(true)}
        />

        {/* ✅ Disaster Cluster Picker */}
        <Modal
          visible={disasterClusterOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setDisasterClusterOpen(false)}
        >
          <Pressable style={styles.backdrop} onPress={() => setDisasterClusterOpen(false)} />
          <View style={styles.clusterWrap}>
            <View style={styles.clusterCard}>
              <View style={styles.clusterHeaderRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.clusterTitle}>{disasterClusterTitle}</Text>
                  <Text style={styles.clusterSubtitle}>Choose a disaster</Text>
                </View>

                <Pressable onPress={() => setDisasterClusterOpen(false)} style={styles.xBtn}>
                  <Text style={styles.xText}>✕</Text>
                </Pressable>
              </View>

              {disasterClusterItems.length === 0 ? (
                <Text style={styles.clusterEmptyText}>No disasters found for this coordinate.</Text>
              ) : (
                <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ paddingBottom: 6 }}>
                  {disasterClusterItems.map((it) => (
                    <Pressable
                      key={`dsel-${it.id}-${it.latitude}-${it.longitude}`}
                      onPress={() => selectFromDisasterCluster(it)}
                      style={({ pressed }) => [styles.nameRow, pressed && styles.pressed]}
                    >
                      <Text style={styles.nameRowTitle} numberOfLines={1}>
                        {it.title}
                      </Text>
                      {!!it.location_name ? (
                        <Text style={styles.nameRowSub} numberOfLines={1}>
                          {String(it.location_name)}
                        </Text>
                      ) : null}
                    </Pressable>
                  ))}
                </ScrollView>
              )}
            </View>
          </View>
        </Modal>

        <Modal
          visible={disasterPreviewOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setDisasterPreviewOpen(false)}
        >
          <Pressable
            style={styles.backdrop}
            onPress={() => {
              setDisasterPreviewOpen(false);
              setSelectedDisaster(null);
            }}
          />
          <View style={styles.clusterWrap}>
            <View style={styles.clusterCard}>
              <View style={styles.clusterHeaderRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.clusterTitle} numberOfLines={2}>
                    {selectedDisaster?.title ?? "Disaster"}
                  </Text>
                  <Text style={styles.clusterSubtitle} numberOfLines={2}>
                    {[
                      selectedDisaster?.disaster_type ? String(selectedDisaster.disaster_type) : null,
                      selectedDisaster?.location_name ? String(selectedDisaster.location_name) : null,
                    ]
                      .filter(Boolean)
                      .join(" • ") || " "}
                  </Text>
                </View>

                <Pressable
                  onPress={() => {
                    setDisasterPreviewOpen(false);
                    setSelectedDisaster(null);
                  }}
                  style={styles.xBtn}
                >
                  <Text style={styles.xText}>✕</Text>
                </Pressable>
              </View>

              {!!selectedDisaster?.subtitle ? (
                <Text style={styles.disasterBody} numberOfLines={3}>
                  {selectedDisaster.subtitle}
                </Text>
              ) : null}

              <View style={{ marginTop: 10, gap: 6 }}>
                {selectedDisaster?.start_date ? (
                  <Text style={styles.disasterMeta}>
                    Date:{" "}
                    <Text style={styles.disasterMetaStrong}>
                      {selectedDisaster.start_date}
                      {selectedDisaster.end_date ? ` → ${selectedDisaster.end_date}` : ""}
                    </Text>
                  </Text>
                ) : null}

                {selectedDisaster?.deaths_est != null ||
                selectedDisaster?.deaths_min != null ||
                selectedDisaster?.deaths_max != null ? (
                  <Text style={styles.disasterMeta}>
                    Deaths:{" "}
                    <Text style={styles.disasterMetaStrong}>
                      {selectedDisaster.deaths_est != null
                        ? `${selectedDisaster.deaths_est.toLocaleString()}`
                        : selectedDisaster.deaths_min != null || selectedDisaster.deaths_max != null
                        ? `${selectedDisaster.deaths_min?.toLocaleString?.() ?? "?"}–${
                            selectedDisaster.deaths_max?.toLocaleString?.() ?? "?"
                          }`
                        : "Unknown"}
                    </Text>
                  </Text>
                ) : null}
              </View>

              <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
                <Pressable
                  onPress={() => {
                    if (!selectedDisaster) return;
                    void openDirections(selectedDisaster.latitude, selectedDisaster.longitude, selectedDisaster.title);
                  }}
                  style={({ pressed }) => [styles.disBtn, pressed && { opacity: 0.85 }]}
                >
                  <Text style={styles.disBtnText}>Directions</Text>
                </Pressable>

                <Pressable
                  onPress={() => {
                    const src = selectedDisaster?.sources;
                    const firstUrl =
                      Array.isArray(src) && src.length
                        ? firstNonEmpty(src[0]?.url, src[0]?.href, src[0]?.link)
                        : undefined;

                    if (firstUrl) {
                      void Linking.openURL(String(firstUrl));
                      return;
                    }

                    Alert.alert("No source link", "This disaster entry doesn’t have a source URL yet.");
                  }}
                  style={({ pressed }) => [styles.disBtnSecondary, pressed && { opacity: 0.85 }]}
                >
                  <Text style={styles.disBtnTextSecondary}>Source</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

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

        <PremiumPaywallModal
          visible={premiumOpen}
          onClose={() => setPremiumOpen(false)}
          onStartTrial={handleStartTrial}
          onRestorePurchases={handleRestorePurchases}
          trialLine="Start 7-Day Free Trial"
          priceLine="$9.99/year after trial"
        />

        {showFadeSplash ? (
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFillObject, { opacity: splashOpacity, backgroundColor: "#0b0c0f", zIndex: 9999 }]}
          >
            <Image source={require("../../assets/splash.png")} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
          </Animated.View>
        ) : null}
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

  titleSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  appTitle: {
    fontFamily: "BaronKuffner",
    fontSize: 24,
    color: "white",
    letterSpacing: 1,
  },

  searchInput: {
    height: 36,
    paddingHorizontal: 12,
    paddingRight: 44,
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
    marginTop: 10,
    flexDirection: "row",
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  modePill: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  modePillActive: { backgroundColor: "rgba(120, 25, 25, 0.75)" },
  modePillText: { color: "rgba(255,255,255,0.75)", fontWeight: "900", fontSize: 11 },
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
  chipLocked: { opacity: 0.45 },
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

  // Pins
  pinWrap: { alignItems: "center", justifyContent: "center" },

  // ✅ Selected pin: let it sit "above" neighbors visually
  pinWrapSelected: {
    zIndex: 999,
    elevation: 999,
  },

  // ✅ Halo behind selected pin (ring + faint fill)
  pinHalo: {
    position: "absolute",
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2.5,
    backgroundColor: "rgba(255,255,255,0.06)",
    transform: [{ translateY: 2 }],
  },

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
    alignItems: "center",
    justifyContent: "center",
  },
  pinInnerCirclePlain: {
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
  },
  pinInnerCircle: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "white",
    alignItems: "center",
    justifyContent: "center",
  },
  clusterCountText: {
    color: "#111827",
    fontWeight: "900",
    fontSize: 10,
    marginTop: -1.3,
    marginLeft: 1,
  },

  disasterBang: {
    color: "#111827",
    fontWeight: "900",
    fontSize: 12,
    marginTop: -1.2,
  },

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

  searchWrap: { position: "relative" },
  clearBtn: {
    position: "absolute",
    right: 10,
    top: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  clearBtnText: {
    color: "rgba(255,255,255,0.85)",
    fontWeight: "900",
    fontSize: 14,
  },

  disasterBody: {
    marginTop: 10,
    color: "rgba(255,255,255,0.82)",
    fontWeight: "800",
    lineHeight: 18,
  },
  disasterMeta: { color: "rgba(255,255,255,0.72)", fontWeight: "800" },
  disasterMetaStrong: { color: "rgba(255,255,255,0.92)", fontWeight: "900" },

  disBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "rgba(245, 158, 11, 0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  disBtnText: { color: "#111827", fontWeight: "900" },

  disBtnSecondary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  disBtnTextSecondary: { color: "rgba(255,255,255,0.90)", fontWeight: "900" },
});