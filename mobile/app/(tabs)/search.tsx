import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, TextInput, FlatList } from "react-native";
import { BlurView } from "expo-blur";

const CATS = ["All", "Murders", "Accidents", "Historical"];

export default function SearchScreen() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");

  const recent = useMemo(
    () => ["Marilyn Monroe", "Alcatraz", "Bonnie and Clyde"],
    []
  );

  return (
    <View style={styles.root}>
      <BlurView intensity={30} tint="dark" style={styles.header}>
        <Text style={styles.headerTitle}>Search Locations</Text>
      </BlurView>

      <View style={styles.pad}>
        <BlurView intensity={25} tint="dark" style={styles.searchBox}>
          <Text style={{ color: "rgba(255,255,255,0.75)", marginRight: 8 }}>🔍</Text>
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search Locations"
            placeholderTextColor="rgba(255,255,255,0.55)"
            style={styles.searchInput}
          />
        </BlurView>

        <View style={styles.chipsRow}>
          {CATS.map((c) => {
            const active = c === cat;
            return (
              <Pressable
                key={c}
                onPress={() => setCat(c)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{c}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.section}>Recent Searches</Text>

        <FlatList
          data={recent}
          keyExtractor={(x) => x}
          renderItem={({ item }) => (
            <Pressable style={styles.row}>
              <Text style={styles.rowTitle}>{item}</Text>
              <Text style={styles.rowArrow}>›</Text>
            </Pressable>
          )}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b0f15" },
  header: {
    height: 64,
    paddingTop: 14,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "flex-end",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.10)",
  },
  headerTitle: { color: "white", fontWeight: "900", fontSize: 16 },

  pad: { padding: 14 },

  searchBox: {
    height: 44,
    borderRadius: 14,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    overflow: "hidden",
  },
  searchInput: { flex: 1, color: "white", fontWeight: "800" },

  chipsRow: { flexDirection: "row", gap: 10, marginTop: 12, marginBottom: 14 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  chipActive: {
    backgroundColor: "rgba(220,38,38,0.35)",
    borderColor: "rgba(220,38,38,0.55)",
  },
  chipText: { color: "rgba(255,255,255,0.75)", fontWeight: "900" },
  chipTextActive: { color: "white" },

  section: { color: "rgba(255,255,255,0.70)", fontWeight: "900", marginTop: 10, marginBottom: 10 },

  row: {
    height: 54,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    paddingHorizontal: 14,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowTitle: { color: "white", fontWeight: "900" },
  rowArrow: { color: "rgba(255,255,255,0.55)", fontSize: 22, fontWeight: "900" },
});
