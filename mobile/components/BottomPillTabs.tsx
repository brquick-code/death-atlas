import React from "react";
import { View, Pressable, Text, StyleSheet, Platform } from "react-native";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";

type TabKey = "directory" | "map" | "new" | "about";

const LABELS: Record<TabKey, string> = {
  directory: "Directory",
  map: "Map",
  new: "New",
  about: "About",
};

export default function BottomPillTabs(props: BottomTabBarProps) {
  const { state, descriptors, navigation } = props;

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        {state.routes.map((route, index) => {
          const isFocused = state.index === index;
          const key = route.name as TabKey;

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

          const onLongPress = () => {
            navigation.emit({
              type: "tabLongPress",
              target: route.key,
            });
          };

          // Hide any unexpected routes
          if (!LABELS[key]) return null;

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              onLongPress={onLongPress}
              style={[styles.pill, isFocused ? styles.pillActive : styles.pillInactive]}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
              accessibilityLabel={descriptors[route.key]?.options?.tabBarAccessibilityLabel}
            >
              <Text style={[styles.pillText, isFocused ? styles.pillTextActive : styles.pillTextInactive]}>
                {LABELS[key]}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 14,
    paddingBottom: Platform.OS === "ios" ? 22 : 14, // gives a nice safe-area-ish buffer
  },
  bar: {
    backgroundColor: "rgba(20, 20, 24, 0.92)",
    borderRadius: 18,
    padding: 10,
    flexDirection: "row",
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  pill: {
    flex: 1,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  pillActive: {
    backgroundColor: "#6d2b2b", // same “active red” vibe as your top Death pill
    borderColor: "rgba(255,255,255,0.14)",
  },
  pillInactive: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.10)",
  },
  pillText: {
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  pillTextActive: { color: "#fff" },
  pillTextInactive: { color: "rgba(255,255,255,0.78)" },
});
