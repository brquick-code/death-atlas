import React, { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { hasSeenOpening } from "../lib/firstRun";

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [initialRoute, setInitialRoute] = useState<"(tabs)" | "opening">("opening");

  useEffect(() => {
    (async () => {
      const seen = await hasSeenOpening();
      setInitialRoute(seen ? "(tabs)" : "opening");
      setReady(true);
    })();
  }, []);

  if (!ready) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0b0f15" }}>
          <ActivityIndicator />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <Stack
        initialRouteName={initialRoute}
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: "#0b0f15" },
        }}
      >
        <Stack.Screen name="opening" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="person/[id]"
          options={{
            presentation: "card",
          }}
        />
      </Stack>
    </SafeAreaProvider>
  );
}
