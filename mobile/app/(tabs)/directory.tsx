// mobile/app/(tabs)/directory.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import PremiumPaywallModal from "../../components/PremiumPaywallModal";
import { usePremium } from "../../lib/premium";

type DirectoryMode = "names" | "disasters";

// extend focus mode to include disasters (Map screen will need to understand this)
type FocusMode = "death" | "burial" | "missing" | "disaster";

type DeathLocationRow = {
  id: string;
  title: string;

  death_latitude?: number | null;
  death_longitude?: number | null;

  burial_latitude?: number | null;
  burial_longitude?: number | null;

  missing_latitude?: number | null;
  missing_longitude?: number | null;
};

type EntrySummary = {
  name: string;
  death?: { lat: number; lng: number };
  burial?: { lat: number; lng: number };
  missing?: { lat: number; lng: number };
};

type DisasterRow = {
  id: string;
  title?: string | null;
  disaster_type?: string | null;
  location_name?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  year?: number | null;
  deaths_est?: number | null;
  deaths_min?: number | null;
  deaths_max?: number | null;

  // expected columns in the API route
  latitude?: number | null;
  longitude?: number | null;

  // just in case your table uses different naming
  lat?: number | null;
  lng?: number | null;
};

function isNum(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function normalizeBaseUrl(raw: string) {
  let s = (raw || "").trim();
  if (!s) return "";
  if (s.endsWith("/")) s = s.slice(0, -1);
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return s;
  }
}

function getApiRoot() {
  const env = normalizeBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL ?? "");
  return env || "https://death-atlas-web.vercel.app";
}

function getNamesApiUrl() {
  // Hard-pin for now since you confirmed this works reliably.
  return "https://death-atlas-web.vercel.app/api/directory?limit=2000&v=999";
}

function getDisastersApiRoot() {
  // Use env if present, but default to your deployed web
  return getApiRoot();
}

async function fetchJson(url: string) {
  const res = await fetch(url);
  const text = await res.text().catch(() => "");

  if (!res.ok) {
    const snippet = text.slice(0, 160);
    throw new Error(`${res.status}: ${snippet}`);
  }

  const t = text.trim();
  const looksLikeHtml = t.startsWith("<!doctype") || t.startsWith("<html");
  if (looksLikeHtml) {
    throw new Error("Got HTML instead of JSON (wrong URL or route not deployed).");
  }

  return JSON.parse(text);
}

function extractList(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const keys = ["items", "rows", "data", "results"];
    for (const k of keys) {
      const v = (data as any)[k];
      if (Array.isArray(v)) return v;
    }
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) return v as any[];
    }
  }
  return [];
}

function formatDateRange(start?: string | null, end?: string | null, year?: number | null) {
  const s = (start ?? "").slice(0, 10);
  const e = (end ?? "").slice(0, 10);

  if (s && e && s !== e) return `${s} → ${e}`;
  if (s) return s;
  if (e) return e;
  if (year != null) return String(year);
  return "";
}

function formatDeaths(r: DisasterRow) {
  const est = isNum(r.deaths_est) ? r.deaths_est : null;
  const min = isNum(r.deaths_min) ? r.deaths_min : null;
  const max = isNum(r.deaths_max) ? r.deaths_max : null;

  if (est != null) return `Deaths: ~${est.toLocaleString()}`;
  if (min != null && max != null) return `Deaths: ${min.toLocaleString()}–${max.toLocaleString()}`;
  if (min != null) return `Deaths: ${min.toLocaleString()}+`;
  if (max != null) return `Deaths: ≤${max.toLocaleString()}`;
  return "";
}

function pickDisasterCoords(r: DisasterRow): { lat: number; lng: number } | null {
  const lat =
    (isNum(r.latitude) ? r.latitude : null) ??
    (isNum(r.lat) ? r.lat : null);

  const lng =
    (isNum(r.longitude) ? r.longitude : null) ??
    (isNum(r.lng) ? r.lng : null);

  if (lat == null || lng == null) return null;
  return { lat, lng };
}

export default function DirectoryScreen() {
  const router = useRouter();

  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>("names");

  // Names (existing)
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<DeathLocationRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [rawKeys, setRawKeys] = useState<string>("");

  // Disasters
  const [dLoading, setDLoading] = useState(false);
  const [dErr, setDErr] = useState<string | null>(null);
  const [dRows, setDRows] = useState<DisasterRow[]>([]);
  const [dCount, setDCount] = useState<number | null>(null);

  const [q, setQ] = useState("");

  // keep for debugging / future env use
  useMemo(() => getApiRoot(), []);
  const namesUrl = useMemo(() => getNamesApiUrl(), []);

  // ✅ Premium (RevenueCat) state + actions
  const { isPremium, startPurchase, restore } = usePremium();
  const [premiumOpen, setPremiumOpen] = useState(false);
  const lockSuffix = " 🔒";

  // Auto-close paywall if premium becomes active
  useEffect(() => {
    if (isPremium && premiumOpen) setPremiumOpen(false);
  }, [isPremium, premiumOpen]);

  function goToMap(mode: FocusMode, name: string, lat: number, lng: number) {
    router.push({
      pathname: "/(tabs)/map",
      params: {
        focusMode: mode,
        focusLat: String(lat),
        focusLng: String(lng),
        focusName: name,
      },
    });
  }

  function requirePremium(action: () => void) {
    if (isPremium) return action();
    setPremiumOpen(true);
  }

  async function loadNames() {
    try {
      setErr(null);
      setRawKeys("");
      setLoading(true);

      const data = await fetchJson(namesUrl);
      const list = extractList(data);

      setRows(list as DeathLocationRow[]);

      if (list.length === 0 && data && typeof data === "object") {
        setRawKeys(Object.keys(data).join(", "));
      }
    } catch (e: any) {
      setRows([]);
      setErr(e?.message || "Failed to load.");
    } finally {
      setLoading(false);
    }
  }

  // initial names load
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!alive) return;
      await loadNames();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesUrl]);

  const byName = useMemo(() => {
    const map = new Map<string, EntrySummary>();

    for (const r of rows) {
      const name = String(r.title ?? "").trim();
      if (!name) continue;

      const entry = map.get(name) ?? { name };

      const dLat = isNum(r.death_latitude) ? r.death_latitude : null;
      const dLng = isNum(r.death_longitude) ? r.death_longitude : null;

      const bLat = isNum(r.burial_latitude) ? r.burial_latitude : null;
      const bLng = isNum(r.burial_longitude) ? r.burial_longitude : null;

      const mLat = isNum(r.missing_latitude) ? r.missing_latitude : null;
      const mLng = isNum(r.missing_longitude) ? r.missing_longitude : null;

      if (!entry.death && dLat != null && dLng != null) entry.death = { lat: dLat, lng: dLng };
      if (!entry.burial && bLat != null && bLng != null) entry.burial = { lat: bLat, lng: bLng };
      if (!entry.missing && mLat != null && mLng != null) entry.missing = { lat: mLat, lng: mLng };

      map.set(name, entry);
    }

    const list = Array.from(map.values());
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [rows]);

  const filteredNames = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return byName;
    return byName.filter((x) => x.name.toLowerCase().includes(needle));
  }, [byName, q]);

  // ---- Disasters fetch (debounced) ----
  const debounceRef = useRef<any>(null);

  async function loadDisasters(queryText: string) {
    try {
      setDErr(null);
      setDLoading(true);

      const apiRoot = getDisastersApiRoot();
      const url =
        `${apiRoot}/api/disasters-directory` +
        `?q=${encodeURIComponent(queryText.trim())}` +
        `&limit=80&offset=0`;

      const data = await fetchJson(url);
      const list = extractList(data);

      setDRows(list as DisasterRow[]);
      setDCount(typeof data?.count === "number" ? data.count : null);
    } catch (e: any) {
      setDRows([]);
      setDCount(null);
      setDErr(e?.message || "Failed to load disasters.");
    } finally {
      setDLoading(false);
    }
  }

  useEffect(() => {
    if (directoryMode !== "disasters") return;

    // Debounce typing so we don't spam requests
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void loadDisasters(q);
    }, 220);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directoryMode, q]);

  // When switching to disasters for first time, load immediately
  useEffect(() => {
    if (directoryMode !== "disasters") return;
    if (dRows.length > 0 || dLoading || dErr) return;
    void loadDisasters(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directoryMode]);

  const headerTitle = directoryMode === "names" ? "Directory" : "Disasters";
  const placeholder = directoryMode === "names" ? "Search names" : "Search disasters";

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>{headerTitle}</Text>

        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder={placeholder}
          placeholderTextColor="rgba(255,255,255,0.55)"
          style={styles.search}
          autoCorrect={false}
          autoCapitalize="none"
        />

        {/* ✅ Names / Disasters toggle */}
        <View style={styles.dirToggleRow}>
          <Pressable
            onPress={() => setDirectoryMode("names")}
            style={[
              styles.dirTogglePill,
              directoryMode === "names" && styles.dirTogglePillActive,
            ]}
          >
            <Text
              style={[
                styles.dirToggleText,
                directoryMode === "names" && styles.dirToggleTextActive,
              ]}
            >
              Names
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setDirectoryMode("disasters")}
            style={[
              styles.dirTogglePill,
              directoryMode === "disasters" && styles.dirTogglePillActive,
            ]}
          >
            <Text
              style={[
                styles.dirToggleText,
                directoryMode === "disasters" && styles.dirToggleTextActive,
              ]}
            >
              Disasters
            </Text>
          </Pressable>
        </View>
      </View>

      {/* ===================== NAMES MODE ===================== */}
      {directoryMode === "names" ? (
        loading ? (
          <View style={styles.center}>
            <ActivityIndicator />
            <Text style={styles.muted}>Loading…</Text>
          </View>
        ) : err ? (
          <View style={styles.center}>
            <Text style={styles.muted}>Error: {err}</Text>
            <Pressable style={styles.retryBtn} onPress={loadNames}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>

            {!!rawKeys ? <Text style={[styles.muted, { marginTop: 8 }]}>Keys: {rawKeys}</Text> : null}
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
            {filteredNames.map((entry) => (
              <View key={entry.name} style={styles.row}>
                <Text style={styles.name}>{entry.name}</Text>

                <View style={styles.badges}>
                  {entry.death ? (
                    <Pill
                      label="Death"
                      onPress={() => goToMap("death", entry.name, entry.death!.lat, entry.death!.lng)}
                    />
                  ) : null}

                  {entry.burial ? (
                    <Pill
                      label={`Burial${!isPremium ? lockSuffix : ""}`}
                      locked={!isPremium}
                      onPress={() =>
                        requirePremium(() => goToMap("burial", entry.name, entry.burial!.lat, entry.burial!.lng))
                      }
                    />
                  ) : null}

                  {entry.missing ? (
                    <Pill
                      label={`Missing${!isPremium ? lockSuffix : ""}`}
                      locked={!isPremium}
                      onPress={() =>
                        requirePremium(() => goToMap("missing", entry.name, entry.missing!.lat, entry.missing!.lng))
                      }
                    />
                  ) : null}
                </View>
              </View>
            ))}

            {filteredNames.length === 0 ? <Text style={styles.muted}>No matches.</Text> : null}
          </ScrollView>
        )
      ) : null}

      {/* ===================== DISASTERS MODE ===================== */}
      {directoryMode === "disasters" ? (
        dLoading ? (
          <View style={styles.center}>
            <ActivityIndicator />
            <Text style={styles.muted}>Loading disasters…</Text>
          </View>
        ) : dErr ? (
          <View style={styles.center}>
            <Text style={styles.muted}>Error: {dErr}</Text>
            <Pressable style={styles.retryBtn} onPress={() => loadDisasters(q)}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
            {typeof dCount === "number" ? (
              <Text style={[styles.muted, { textAlign: "left", marginBottom: 6 }]}>
                Showing {dRows.length} of {dCount.toLocaleString()}
              </Text>
            ) : null}

            {dRows.map((r) => {
              const title = String(r.title ?? "").trim() || "(Untitled disaster)";
              const type = String(r.disaster_type ?? "").trim();
              const loc = String(r.location_name ?? "").trim();
              const dateRange = formatDateRange(r.start_date, r.end_date, r.year ?? null);
              const deaths = formatDeaths(r);
              const coords = pickDisasterCoords(r);

              const subtitlePieces = [
                type ? type : "",
                loc ? loc : "",
                dateRange ? dateRange : "",
              ].filter(Boolean);

              const subtitle = subtitlePieces.join(" • ");

              const disabled = !coords;

              return (
                <Pressable
                  key={r.id}
                  onPress={() => {
                    if (!coords) return;
                    goToMap("disaster", title, coords.lat, coords.lng);
                  }}
                  style={({ pressed }) => [
                    styles.row,
                    disabled && { opacity: 0.55 },
                    pressed && !disabled && { opacity: 0.88 },
                  ]}
                >
                  <Text style={styles.name}>{title}</Text>
                  {!!subtitle ? <Text style={styles.sub}>{subtitle}</Text> : null}
                  {!!deaths ? <Text style={styles.sub}>{deaths}</Text> : null}
                  {!coords ? <Text style={styles.subMuted}>No coordinates yet.</Text> : null}
                </Pressable>
              );
            })}

            {dRows.length === 0 ? <Text style={styles.muted}>No matches.</Text> : null}
          </ScrollView>
        )
      ) : null}

      <PremiumPaywallModal
        visible={premiumOpen}
        onClose={() => setPremiumOpen(false)}
        onStartTrial={() => {
          void Promise.resolve(startPurchase()).catch((e) => console.log("Purchase failed", e));
        }}
        onRestorePurchases={() => {
          void Promise.resolve(restore()).catch((e) => console.log("Restore failed", e));
        }}
        trialLine="Start 7-Day Free Trial"
        priceLine="$9.99/year after trial"
      />
    </SafeAreaView>
  );
}

function Pill({
  label,
  onPress,
  locked,
}: {
  label: string;
  onPress: () => void;
  locked?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.badge, locked && styles.badgeLocked, pressed && { opacity: 0.82 }]}
    >
      <Text style={styles.badgeText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0b0c0f" },
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12 },
  title: { color: "#fff", fontSize: 22, fontWeight: "800", marginBottom: 6 },

  search: {
    height: 40,
    borderRadius: 12,
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    color: "#fff",
    marginTop: 6,
  },

  // toggle chips
  dirToggleRow: {
    marginTop: 10,
    flexDirection: "row",
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  dirTogglePill: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  dirTogglePillActive: {
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  dirToggleText: {
    color: "rgba(255,255,255,0.75)",
    fontWeight: "900",
    fontSize: 13,
  },
  dirToggleTextActive: {
    color: "rgba(255,255,255,0.95)",
  },

  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 16 },
  muted: { color: "rgba(255,255,255,0.7)", textAlign: "center" },

  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 14,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  retryText: { color: "rgba(255,255,255,0.9)", fontWeight: "900" },

  list: { paddingHorizontal: 16, paddingBottom: 110, gap: 10 },

  row: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    borderRadius: 14,
    padding: 12,
    gap: 6,
  },
  name: { color: "#fff", fontSize: 16, fontWeight: "800" },

  sub: { color: "rgba(255,255,255,0.78)", fontSize: 13, fontWeight: "700" },
  subMuted: { color: "rgba(255,255,255,0.55)", fontSize: 12, fontWeight: "700" },

  badges: { flexDirection: "row", flexWrap: "wrap", gap: 8 },

  badge: {
    paddingHorizontal: 12,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  badgeLocked: { opacity: 0.48 },
  badgeText: { color: "rgba(255,255,255,0.85)", fontWeight: "800", fontSize: 12 },
});