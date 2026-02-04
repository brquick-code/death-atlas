import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { BlurView } from "expo-blur";

export default function ProfileScreen() {
  return (
    <View style={styles.root}>
      <BlurView intensity={30} tint="dark" style={styles.header}>
        <Text style={styles.headerTitle}>Profile</Text>
      </BlurView>

      <View style={{ padding: 14 }}>
        <View style={styles.card}>
          <Text style={styles.h}>Coming soon</Text>
          <Text style={styles.p}>Favorites, saved places, and settings will live here.</Text>
        </View>
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
  card: {
    padding: 14,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  h: { color: "white", fontWeight: "900", fontSize: 16 },
  p: { color: "rgba(255,255,255,0.70)", marginTop: 8, fontWeight: "700" },
});
