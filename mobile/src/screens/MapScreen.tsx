// mobile/src/screens/MapScreen.tsx
//
// Works with react-native-maps. Tap a marker to open a modal with SourcesList.

import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
} from "react-native";
import MapView, { Marker, Region } from "react-native-maps";
import SourcesList from "../components/SourcesList";

export type DeathLocation = {
  id: string;
  title: string;
  latitude: number;
  longitude: number;

  // New:
  source_urls?: string[] | null;

  // Legacy (optional):
  source_url?: string | null;
};

type Props = {
  data: DeathLocation[]; // pass in whatever you’re already using for pins
};

export default function MapScreen({ data }: Props) {
  const [selected, setSelected] = useState<DeathLocation | null>(null);

  const initialRegion: Region = useMemo(() => {
    const first = data?.[0];
    if (first) {
      return {
        latitude: first.latitude,
        longitude: first.longitude,
        latitudeDelta: 12,
        longitudeDelta: 12,
      };
    }
    // fallback
    return {
      latitude: 39.5,
      longitude: -98.35,
      latitudeDelta: 40,
      longitudeDelta: 40,
    };
  }, [data]);

  return (
    <View style={styles.container}>
      <MapView style={styles.map} initialRegion={initialRegion}>
        {data.map((row) => (
          <Marker
            key={row.id}
            coordinate={{ latitude: row.latitude, longitude: row.longitude }}
            title={row.title}
            onPress={() => setSelected(row)}
          />
        ))}
      </MapView>

      <Modal
        visible={!!selected}
        transparent
        animationType="slide"
        onRequestClose={() => setSelected(null)}
      >
        <SafeAreaView style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle} numberOfLines={2}>
                {selected?.title ?? ""}
              </Text>

              <Pressable onPress={() => setSelected(null)} style={styles.closeBtn}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.modalBody}>
              <Text style={styles.meta}>
                {selected
                  ? `${selected.latitude.toFixed(6)}, ${selected.longitude.toFixed(6)}`
                  : ""}
              </Text>

              <SourcesList
                sourceUrls={selected?.source_urls ?? null}
                legacySourceUrl={selected?.source_url ?? null}
              />
            </ScrollView>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    minHeight: "45%",
    maxHeight: "85%",
    paddingBottom: 18,
  },
  modalHeader: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12 as any,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", flex: 1 },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#ddd",
  },
  closeText: { fontSize: 14, fontWeight: "700" },
  modalBody: { padding: 16, gap: 12 as any },
  meta: { fontSize: 12, color: "#666" },
});
