import React from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";

const APP_VERSION = "1.0.0";

export default function AboutScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Header */}
        <View style={styles.headerWrap}>
          <View style={styles.iconWrap}>
            <MaterialCommunityIcons name="map-marker-radius" size={28} color="#dc2626" />
            <MaterialCommunityIcons
              name="skull"
              size={14}
              color="#ffffff"
              style={styles.skullOverlay}
            />
          </View>

          <Text style={styles.brand}>DEATH ATLAS</Text>
        </View>

        {/* Body */}
        <Text style={styles.sectionTitle}>About Death Atlas</Text>

        <Text style={styles.paragraph}>
          Death Atlas is a guide to final locations — a curated map of notable
          death and burial sites, as well as the last known locations of missing
          individuals.
        </Text>

        <Text style={styles.paragraph}>
          It maps the places where history stopped — where stories ended, where
          lives changed forever, and where individuals met their final moment.
          It also marks where they were ultimately laid to rest, and where some
          were last seen, connecting events to the physical spaces that hold
          their memory.
        </Text>

        <Text style={styles.paragraph}>
          Each pin represents a real person and a real place, grounded in
          documented sources.
        </Text>

        <Text style={styles.paragraph}>
          Whether tragic, historic, or culturally significant, these locations
          form a quiet geography of memory.
        </Text>

        <Text style={styles.footerHighlight}>
          New entries are added weekly as the map continues to grow.
        </Text>

        {/* Version + Creator */}
        <Text style={styles.version}>Version {APP_VERSION}</Text>
        <Text style={styles.creator}>Created by BRQ/Black Tides Software</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0b0c0f",
  },
  container: {
    paddingHorizontal: 22,
    paddingTop: 30,
    paddingBottom: 120,
  },

  headerWrap: {
    alignItems: "center",
    marginBottom: 26,
  },

  iconWrap: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
    position: "relative",
  },

  skullOverlay: {
    position: "absolute",
    top: 15,
  },

  brand: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: 2,
  },

  sectionTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 16,
  },

  paragraph: {
    color: "rgba(255,255,255,0.88)",
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 16,
  },

  footerHighlight: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 14,
    fontWeight: "800",
    marginTop: 10,
  },

  version: {
    marginTop: 40,
    textAlign: "center",
    color: "rgba(255,255,255,0.45)",
    fontSize: 12,
    letterSpacing: 1,
  },

  creator: {
    marginTop: 6,
    textAlign: "center",
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
    letterSpacing: 1,
  },
});
