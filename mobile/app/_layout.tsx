// mobile/app/_layout.tsx
import React, { useEffect } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { initRevenueCat } from "../lib/premium";

// Keep the native splash screen visible until we manually hide it.
// (You already hide it later from app/index.tsx after pins load.)
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  // 🔤 Load fonts here (adjust filenames to match what you actually put in assets/fonts)
  const [fontsLoaded] = useFonts({
    // Example font name you'll reference as fontFamily: "DeathAtlasTitle"
    DeathAtlasTitle: require("../assets/fonts/BaronKuffner.otf"),
  });

  useEffect(() => {
    // Initialize RevenueCat once when app loads
    void initRevenueCat();
  }, []);

  // Don't render routes until fonts are ready
  // (We still won't hide splash here — you do that later in index.tsx)
  if (!fontsLoaded) return null;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "fade",
      }}
    />
  );
}