// mobile/app/(tabs)/new.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Platform,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import PremiumPaywallModal from "../../components/PremiumPaywallModal";
import { usePremium } from "../../lib/premium";

type CoordMode = "death" | "burial" | "missing";

type NewItem = {
  id: string;
  name: string;

  death_latitude?: number | null;
  death_longitude?: number | null;

  burial_latitude?: number | null;
  burial_longitude?: number | null;

  missing_latitude?: number | null;
  missing_longitude?: number | null;

  created_at?: string | null;
};

function isNum(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function apiRoot() {
  return process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ?? "https://death-atlas-web.vercel.app";
}

function getNewUrl() {
  const root = apiRoot().replace(/\/$/, "");
  return `${root}/api/directory?sort=newest&limit=10&v=999`;
}

function safeName(raw: any) {
  const n = String(raw ?? "").trim();
  if (!n) return "";
  if (n.startsWith("<!DOCTYPE") || n.startsWith("<html")) return "";
  if (n.includes("<html") || n.includes("</")) return "";
  return n;
}

function formatPurchaseHelpMessage(errMessage?: string) {
  const extra =
    "\n\nIf you’re testing subscriptions:\n" +
    "• Make sure the subscription product exists in App Store Connect.\n" +
    "• Make sure you’re signed into a Sandbox tester on the device (Settings → App Store → Sandbox Account).\n" +
    "• If products aren’t returned yet, Apple sometimes needs a bit after creation.";
  return (errMessage ? `${errMessage}` : "Purchase failed.") + extra;
}

export default function NewTabScreen() {
  const router = useRouter();

  // ✅ use the real premium state (same as map.tsx)
  const { isPremium, startPurchase, restore } = usePremium();

  const [premiumOpen, setPremiumOpen] = useState(false);
  const lockSuffix = " 🔒";

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<NewItem[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // Auto-close paywall if premium becomes active
  useEffect(() => {
    if (isPremium && premiumOpen) setPremiumOpen(false);
  }, [isPremium, premiumOpen]);

  const url = useMemo(() => getNewUrl(), []);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        setErr(null);
        setLoading(true);

        const res = await fetch(url);
        const contentType = res.headers.get("content-type") || "";

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(`Fetch failed (${res.status}) ${txt}`.trim());
        }

        if (!contentType.includes("application/json")) {
          const txt = await res.text().catch(() => "");
          throw new Error(`Expected JSON but got ${contentType || "unknown"}: ${txt.slice(0, 80)}…`);
        }

        const json = await res.json();

        const list: any[] = Array.isArray(json)
          ? json
          : Array.isArray(json?.items)
          ? json.items
          : Array.isArray(json?.rows)
          ? json.rows
          : Array.isArray(json?.data)
          ? json.data
          : Array.isArray(json?.results)
          ? json.results
          : [];

        const cleaned: NewItem[] = list
          .map((r: any) => {
            const name = safeName(r.title ?? r.name);
            if (!name) return null;

            return {
              id: String(r.id ?? `${name}-${Math.random()}`),
              name,
              created_at: r.created_at ?? r.createdAt ?? null,

              death_latitude: isNum(r.death_latitude) ? r.death_latitude : null,
              death_longitude: isNum(r.death_longitude) ? r.death_longitude : null,

              burial_latitude: isNum(r.burial_latitude) ? r.burial_latitude : null,
              burial_longitude: isNum(r.burial_longitude) ? r.burial_longitude : null,

              missing_latitude: isNum(r.missing_latitude) ? r.missing_latitude : null,
              missing_longlongitude: null as any, // keep TS happy if stray field exists
              missing_longitude: isNum(r.missing_longitude) ? r.missing_longitude : null,
            } as NewItem;
          })
          .filter(Boolean) as NewItem[];

        if (alive) setItems(cleaned.slice(0, 10));
      } catch (e: any) {
        if (alive) setErr(e?.message ?? "Failed to load.");
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [url]);

  function goToMap(mode: CoordMode, name: string, lat: number, lng: number) {
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

  async function handleStartTrial() {
    try {
      await Promise.resolve(startPurchase());
      if (!isPremium) await new Promise((r) => setTimeout(r, 300));
    } catch (e: any) {
      Alert.alert("Couldn’t start subscription", formatPurchaseHelpMessage(e?.message ? String(e.message) : undefined));
      throw e;
    }
  }

  async function handleRestorePurchases() {
    try {
      await Promise.resolve(restore());
    } catch (e: any) {
      Alert.alert("Restore failed", formatPurchaseHelpMessage(e?.message ? String(e.message) : undefined));
      throw e;
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>New</Text>
        <Text style={styles.sub}>Latest additions to Death Atlas.</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.muted}>Loading…</Text>
        </View>
      ) : err ? (
        <View style={styles.center}>
          <Text style={styles.muted}>Error: {err}</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.muted}>No new entries yet.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {items.map((it) => {
            const hasDeath = isNum(it.death_latitude) && isNum(it.death_longitude);
            const hasBurial = isNum(it.burial_latitude) && isNum(it.burial_longitude);
            const hasMissing = isNum(it.missing_latitude) && isNum(it.missing_longitude);

            return (
              <View key={it.id} style={styles.row}>
                <Text style={styles.name}>{it.name}</Text>

                <View style={styles.badges}>
                  {hasDeath ? (
                    <Pill
                      label="Death"
                      onPress={() => goToMap("death", it.name, it.death_latitude!, it.death_longitude!)}
                    />
                  ) : null}

                  {hasBurial ? (
                    <Pill
                      label={`Burial${!isPremium ? lockSuffix : ""}`}
                      locked={!isPremium}
                      onPress={() =>
                        requirePremium(() => goToMap("burial", it.name, it.burial_latitude!, it.burial_longitude!))
                      }
                    />
                  ) : null}

                  {hasMissing ? (
                    <Pill
                      label={`Missing${!isPremium ? lockSuffix : ""}`}
                      locked={!isPremium}
                      onPress={() =>
                        requirePremium(() => goToMap("missing", it.name, it.missing_latitude!, it.missing_longitude!))
                      }
                    />
                  ) : null}
                </View>

                {!!it.created_at ? <Text style={styles.meta}>Added: {String(it.created_at).slice(0, 10)}</Text> : null}
              </View>
            );
          })}

          <View style={{ height: 12 }} />
        </ScrollView>
      )}

      <PremiumPaywallModal
        visible={premiumOpen}
        onClose={() => setPremiumOpen(false)}
        onStartTrial={handleStartTrial}
        onRestorePurchases={handleRestorePurchases}
        trialLine="Start 7-Day Free Trial"
        priceLine="$9.99/year after trial"
        backLabel="Back to New"
        onBack={() => setPremiumOpen(false)}
      />
    </SafeAreaView>
  );
}

function Pill({ label, onPress, locked }: { label: string; onPress: () => void; locked?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.badge, locked && styles.badgeLocked, pressed && { opacity: 0.82 }]}>
      <Text style={styles.badgeText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0b0c0f" },
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10 },
  title: { color: "#fff", fontSize: 22, fontWeight: "900" },
  sub: { color: "rgba(255,255,255,0.70)", marginTop: 6, fontWeight: "800" },

  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 16 },
  muted: { color: "rgba(255,255,255,0.7)", textAlign: "center" },

  list: { paddingHorizontal: 16, paddingBottom: Platform.OS === "ios" ? 120 : 110, gap: 10 },
  row: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    borderRadius: 14,
    padding: 12,
    gap: 8,
  },
  name: { color: "#fff", fontSize: 16, fontWeight: "900" },
  meta: { color: "rgba(255,255,255,0.55)", fontWeight: "800", fontSize: 12 },

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
  badgeText: { color: "rgba(255,255,255,0.85)", fontWeight: "900", fontSize: 12 },
});