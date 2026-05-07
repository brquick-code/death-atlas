import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet, Linking } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { fetchOne } from "../../lib/data";

export default function PersonScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const id = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? params.id[0] : "";

  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        setLoading(true);
        setError(null);
        setRow(null);

        if (!id) {
          throw new Error("Missing id param");
        }

        const r = await fetchOne(id);
        if (!alive) return;

        if (!r) {
          setError("Not found (fetchOne returned null). Check RLS/published flags.");
          setRow(null);
          return;
        }

        setRow(r);
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message ?? String(e));
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
  onPress={() => {
    const canGoBack =
      typeof (router as any).canGoBack === "function"
        ? (router as any).canGoBack()
        : false;

    if (canGoBack) router.back();
    else router.replace("/"); // goes back to map
  }}
  style={styles.backBtn}
>

          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Details</Text>
        <View style={{ width: 54 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.subtle}>Loading…</Text>
          <Text style={styles.subtleSmall}>id: {id || "(none)"}</Text>
        </View>
      ) : error ? (
        <ScrollView contentContainerStyle={styles.pad}>
          <Text style={styles.h1}>Couldn’t load</Text>
          <Text style={styles.err}>{error}</Text>
          <Text style={styles.subtleSmall}>id: {id || "(none)"}</Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Quick checks</Text>
            <Text style={styles.meta}>• Is the row is_published=true and is_hidden=false?</Text>
            <Text style={styles.meta}>• Do you have a SELECT RLS policy for anon?</Text>
            <Text style={styles.meta}>• Is EXPO_PUBLIC_SUPABASE_* loaded?</Text>
          </View>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.pad}>
          <Text style={styles.h1}>{row?.title ?? "Unknown"}</Text>

          <View style={styles.card}>
            <Text style={styles.meta}>
              {row?.death_date ? `d. ${row.death_date}` : row?.date_end ? `d. ${row.date_end}` : ""}
            </Text>
            {!!row?.confidence && <Text style={styles.meta}>confidence: {row.confidence}</Text>}
            {!!row?.coord_source && <Text style={styles.meta}>coord_source: {row.coord_source}</Text>}
            {typeof row?.lat === "number" && typeof row?.lng === "number" && (
              <Text style={styles.meta}>
                {row.lat.toFixed(5)}, {row.lng.toFixed(5)}
              </Text>
            )}
            <Text style={styles.subtleSmall}>id: {id}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sources</Text>

            {!!row?.wikipedia_url && (
              <Pressable onPress={() => Linking.openURL(row.wikipedia_url)} style={styles.linkBtn}>
                <Text style={styles.linkText}>Open Wikipedia</Text>
              </Pressable>
            )}

            {!!row?.source_url && (
              <Pressable onPress={() => Linking.openURL(row.source_url)} style={styles.linkBtn}>
                <Text style={styles.linkText}>Open Source</Text>
              </Pressable>
            )}

            {Array.isArray(row?.source_urls) &&
              row.source_urls.slice(0, 10).map((u: string) => (
                <Pressable key={u} onPress={() => Linking.openURL(u)} style={styles.smallLink}>
                  <Text style={styles.smallLinkText} numberOfLines={1}>
                    {u}
                  </Text>
                </Pressable>
              ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1220" },

  header: {
    height: 56,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#111827",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.10)",
  },
  headerTitle: { color: "white", fontWeight: "900", fontSize: 16 },

  backBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  backText: { color: "white", fontWeight: "800" },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  pad: { padding: 14 },

  h1: { color: "white", fontSize: 22, fontWeight: "900", marginBottom: 10 },
  err: { color: "#fecaca", fontSize: 14, fontWeight: "800", marginBottom: 10 },

  subtle: { color: "#cbd5e1", marginTop: 10 },
  subtleSmall: { color: "#94a3b8", marginTop: 8, fontSize: 12 },

  card: {
    backgroundColor: "rgba(17,24,39,0.95)",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    marginBottom: 12,
  },
  cardTitle: { color: "white", fontSize: 14, fontWeight: "900", marginBottom: 8 },
  meta: { color: "#cbd5e1", marginTop: 6 },

  linkBtn: {
    marginTop: 10,
    backgroundColor: "rgba(220,38,38,0.9)",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    alignSelf: "flex-start",
  },
  linkText: { color: "white", fontWeight: "900" },

  smallLink: {
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  smallLinkText: { color: "#e5e7eb", fontSize: 12 },
});
