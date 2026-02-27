import React from "react";
import { Tabs } from "expo-router";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { View, Pressable, Text, StyleSheet, Platform } from "react-native";

const TAB_BAR_HEIGHT = Platform.OS === "ios" ? 64 : 56;
const TAB_BAR_SAFE_BOTTOM = Platform.OS === "ios" ? 18 : 10; // tweak if you want it higher/lower

function ChipTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  return (
    <View pointerEvents="box-none" style={styles.root}>
      <View style={styles.row}>
        {state.routes.map((route, index) => {
          const isFocused = state.index === index;

          const onPress = () => {
            const event = navigation.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });

            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          const label =
            descriptors[route.key]?.options?.title ??
            descriptors[route.key]?.options?.tabBarLabel ??
            route.name;

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              style={({ pressed }) => [
                styles.chip,
                isFocused ? styles.chipActive : styles.chipInactive,
                pressed && { opacity: 0.86 },
              ]}
            >
              <Text style={[styles.chipText, isFocused ? styles.chipTextActive : styles.chipTextInactive]}>
                {String(label)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <ChipTabBar {...props} />}
      screenOptions={{
        headerShown: false,

        // ✅ Prevent RN from reserving extra space that can look like a “black band”
        tabBarStyle: { display: "none" },
      }}
    >
      <Tabs.Screen name="directory" options={{ title: "Directory" }} />
      <Tabs.Screen name="map" options={{ title: "Map" }} />
      <Tabs.Screen name="new" options={{ title: "New" }} />
      <Tabs.Screen name="about" options={{ title: "About" }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  // This container is only for positioning the tab bar overlay.
  root: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: TAB_BAR_SAFE_BOTTOM,
    paddingHorizontal: 14,
    height: TAB_BAR_HEIGHT,
    justifyContent: "center",
  },

  row: {
    height: TAB_BAR_HEIGHT,
    backgroundColor: "rgba(20, 20, 24, 0.92)",
    borderRadius: 18,
    paddingHorizontal: 10,
    paddingVertical: 10,
    flexDirection: "row",
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
  },

  chip: {
    flex: 1,
    height: 34,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  chipActive: {
    backgroundColor: "rgba(125, 35, 35, 0.95)",
    borderColor: "rgba(255,255,255,0.14)",
  },
  chipInactive: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.10)",
  },
  chipText: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  chipTextActive: { color: "#fff" },
  chipTextInactive: { color: "rgba(255,255,255,0.78)" },
});
