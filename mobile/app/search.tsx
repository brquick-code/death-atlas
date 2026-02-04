// C:\death-atlas\mobile\app\search.tsx

import React, { useMemo, useRef, useState } from "react";
import {
  Keyboard,
  Platform,
  Pressable,
  SafeAreaView,
  Text,
  TextInput,
  View,
  FlatList,
} from "react-native";
import { router } from "expo-router";
import { BlurView } from "expo-blur";

import { apiGetJson } from "../src/lib/api";
import { setFocusTarget } from "../src/lib/focus";

type SearchResult = {
  id: string;
  title: string;

  wikipedia_url?: string | null;

  // legacy single source (still supported)
  source_url?: string | null;

  // multi-source
  source_urls?: string[] | null;

  death_date?: string | null;
  date_start?: string | null;
  date_end?: string | null;
  confidence?: string | null;
  coord_source?: string | null;

  lat?: number | null;
  lng?: number | null;
};

function formatDate(d?: string | null) {
  return d ?? "";
}

export default function SearchScreen() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const inputRef = useRef<TextInput | null>(null);
  const canSearch = useMemo(() => q.trim().length >= 2, [q]);

  async function runSearch(text: string) {
    const query = text.trim();
    if (query.length < 2) {
      setResults([]);
      setErr("");
      return;
    }

    setLoading(true);
    setErr("");

    try {
      const json = await apiGetJson<any>(
        `/api/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(30)}`
      );

      const arr = Array.isArray(json)
        ? json
        : Array.isArray(json?.data)
          ? json.data
          : [];

      setResults(arr as SearchResult[]);
    } catch (e: any) {
      setResults([]);
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  function onPick(r: SearchResult) {
    const lat = typeof r.lat === "number" ? r.lat : null;
    const lng = typeof r.lng === "number" ? r.lng : null;
    if (lat == null || lng == null) return;

    setFocusTarget({
      id: r.id,
      title: r.title,
      lat,
      lng,

      wikipedia_url: r.wikipedia_url ?? null,
      source_url: r.source_url ?? null,
      source_urls: Array.isArray(r.source_urls) ? r.source_urls : null,

      death_date: r.death_date ?? null,
      date_start: r.date_start ?? null,
      date_end: r.date_end ?? null,
      confidence: r.confidence ?? null,
      coord_source: r.coord_source ?? null,
    });

    Keyboard.dismiss();
    router.back();
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "black" }}>
      <View style={{ flex: 1, padding: 14 }}>
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Pressable
            onPress={() => router.back()}
            style={{ width: 44, height: 44, borderRadius: 16, overflow: "hidden" }}
          >
            <BlurView
              intensity={40}
              tint="dark"
              style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ color: "white", fontSize: 18 }}>‹</Text>
            </BlurView>
          </Pressable>

          <Text style={{ color: "white", fontSize: 22, fontWeight: "900" }}>
            Search
          </Text>
        </View>

        {/* Search Input */}
        <View style={{ marginTop: 12, borderRadius: 18, overflow: "hidden" }}>
          <BlurView
            intensity={35}
            tint="dark"
            style={{
              padding: 12,
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.10)",
            }}
          >
            <TextInput
              ref={inputRef}
              value={q}
              onChangeText={(t) => {
                setQ(t);
                runSearch(t); // typeahead
              }}
              placeholder="Search names, places, events…"
              placeholderTextColor="rgba(255,255,255,0.45)"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => runSearch(q)}
              style={{
                color: "white",
                fontSize: 16,
                fontWeight: "700",
                paddingVertical: Platform.OS === "ios" ? 6 : 2,
              }}
            />
          </BlurView>
        </View>

        {/* Status */}
        <View style={{ marginTop: 10 }}>
          {loading ? (
            <Text style={{ color: "rgba(255,255,255,0.65)" }}>Searching…</Text>
          ) : err ? (
            <Text style={{ color: "rgba(255,120,120,0.95)" }}>{err}</Text>
          ) : !canSearch ? (
            <Text style={{ color: "rgba(255,255,255,0.55)" }}>
              Type at least 2 characters.
            </Text>
          ) : results.length === 0 ? (
            <Text style={{ color: "rgba(255,255,255,0.55)" }}>No results.</Text>
          ) : null}
        </View>

        {/* Results */}
        <View style={{ flex: 1, marginTop: 10 }}>
          <FlatList
            data={results}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const meta = [
                formatDate(item.death_date ?? item.date_end ?? item.date_start),
                item.confidence ?? "",
                item.coord_source ?? "",
              ]
                .filter(Boolean)
                .join(" · ");

              const hasCoords =
                typeof item.lat === "number" && typeof item.lng === "number";

              return (
                <Pressable
                  onPress={() => (hasCoords ? onPick(item) : null)}
                  style={{
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                    borderRadius: 18,
                    backgroundColor: "rgba(255,255,255,0.06)",
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.10)",
                    marginBottom: 10,
                    opacity: hasCoords ? 1 : 0.55,
                  }}
                >
                  <Text
                    style={{
                      color: "white",
                      fontWeight: "900",
                      fontSize: 16,
                    }}
                  >
                    {item.title}
                  </Text>

                  {meta ? (
                    <Text
                      style={{
                        color: "rgba(255,255,255,0.65)",
                        marginTop: 4,
                        fontSize: 12,
                      }}
                    >
                      {meta}
                    </Text>
                  ) : null}

                  {!hasCoords ? (
                    <Text
                      style={{
                        color: "rgba(255,180,120,0.85)",
                        marginTop: 6,
                        fontSize: 12,
                      }}
                    >
                      No coordinates available
                    </Text>
                  ) : null}
                </Pressable>
              );
            }}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}
