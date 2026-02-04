// mobile/src/components/SourcesList.tsx

import React, { useMemo } from "react";
import { View, Text, StyleSheet, Pressable, Linking, Alert } from "react-native";
import { normalizeSources, SourceLink } from "../lib/sources";

type Props = {
  sourceUrls?: string[] | null;
  legacySourceUrl?: string | null;
  title?: string;
  emptyText?: string;
};

export default function SourcesList({
  sourceUrls,
  legacySourceUrl,
  title = "Sources",
  emptyText = "No sources available.",
}: Props) {
  const links = useMemo(
    () => normalizeSources({ sourceUrls, legacySourceUrl }),
    [sourceUrls, legacySourceUrl]
  );

  async function open(url: string) {
    try {
      const ok = await Linking.canOpenURL(url);
      if (!ok) return Alert.alert("Can't open link", url);
      await Linking.openURL(url);
    } catch (e: any) {
      Alert.alert("Failed to open link", e?.message ?? String(e));
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.header}>{title}</Text>

      {links.length === 0 ? (
        <Text style={styles.empty}>{emptyText}</Text>
      ) : (
        <View style={styles.list}>
          {links.map((s) => (
            <SourceRow key={s.url} link={s} onPress={() => open(s.url)} />
          ))}
        </View>
      )}
    </View>
  );
}

function SourceRow({
  link,
  onPress,
}: {
  link: SourceLink;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.label}>{link.label}</Text>
        <Text style={styles.url} numberOfLines={1}>
          {link.url}
        </Text>
      </View>
      <Text style={styles.chev}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 12,
    backgroundColor: "#fff",
  },
  header: { fontSize: 16, fontWeight: "700", marginBottom: 8 },
  empty: { fontSize: 14, color: "#666" },
  list: { gap: 10 as any },
  row: {
    borderWidth: 1,
    borderColor: "#eee",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowText: { flex: 1, paddingRight: 10 },
  label: { fontSize: 14, fontWeight: "700", marginBottom: 2 },
  url: { fontSize: 12, color: "#555" },
  chev: { fontSize: 22, color: "#999", marginLeft: 6 },
});
