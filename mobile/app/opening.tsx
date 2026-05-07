import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ImageBackground,
  Pressable,
  StatusBar,
  Animated,
  Easing,
} from "react-native";
import { useRouter } from "expo-router";
import { prime } from "../lib/deathLocationsPrefetch";
import { markSeenOpening } from "../lib/firstRun";

export default function Opening() {
  const router = useRouter();

  // element animations
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoY = useRef(new Animated.Value(12)).current;

  const titleOpacity = useRef(new Animated.Value(0)).current;
  const titleY = useRef(new Animated.Value(12)).current;

  const subOpacity = useRef(new Animated.Value(0)).current;
  const subY = useRef(new Animated.Value(12)).current;

  // whole-screen fade-out
  const screenOpacity = useRef(new Animated.Value(1)).current;
  const screenScale = useRef(new Animated.Value(1)).current;

  const didNavigate = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goNext = async () => {
    if (didNavigate.current) return;
    didNavigate.current = true;

    if (timerRef.current) clearTimeout(timerRef.current);

    await markSeenOpening();

    Animated.parallel([
      Animated.timing(screenOpacity, {
        toValue: 0,
        duration: 420,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(screenScale, {
        toValue: 0.96,
        duration: 420,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(() => {
      router.replace("/(tabs)");
    });
  };

  useEffect(() => {
    // ---- PREFETCH FIRST MAP PAYLOAD ----
    const apiBase = (process.env.EXPO_PUBLIC_API_BASE_URL || "").replace(/\/$/, "");

    if (apiBase) {
      const minLat = 30.5;
      const maxLat = 48.5;
      const minLng = -107.35;
      const maxLng = -89.35;

      const firstUrl =
        `${apiBase}/api/death-locations` +
        `?minLat=${minLat}&minLng=${minLng}&maxLat=${maxLat}&maxLng=${maxLng}` +
        `&zoom=20&coord=death&published=true`;

      prime(firstUrl, async () => {
        const res = await fetch(firstUrl);
        if (!res.ok) throw new Error("Prefetch failed");
        return res.json();
      });
    }
    // -----------------------------------

    const logo = Animated.parallel([
      Animated.timing(logoOpacity, {
        toValue: 1,
        duration: 700,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(logoY, {
        toValue: 0,
        duration: 700,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);

    const title = Animated.parallel([
      Animated.timing(titleOpacity, {
        toValue: 1,
        duration: 650,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(titleY, {
        toValue: 0,
        duration: 650,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);

    const sub = Animated.parallel([
      Animated.timing(subOpacity, {
        toValue: 1,
        duration: 650,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(subY, {
        toValue: 0,
        duration: 650,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);

    Animated.sequence([logo, Animated.delay(120), title, Animated.delay(90), sub]).start();

    timerRef.current = setTimeout(goNext, 2400);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <Pressable style={{ flex: 1 }} onPress={goNext}>
      <StatusBar barStyle="light-content" />

      <Animated.View
        style={{
          flex: 1,
          opacity: screenOpacity,
          transform: [{ scale: screenScale }],
        }}
      >
        <ImageBackground
          source={require("../assets/smoke-texture.jpg")}
          style={styles.background}
          resizeMode="cover"
        >
          <View style={styles.overlay} />

          <View style={styles.content}>
            <Animated.Image
              source={require("../assets/death-atlas-logo.png")}
              style={[
                styles.logo,
                { opacity: logoOpacity, transform: [{ translateY: logoY }] },
              ]}
            />

            <Animated.Text
              style={[
                styles.title,
                { opacity: titleOpacity, transform: [{ translateY: titleY }] },
              ]}
            >
              DEATH ATLAS
            </Animated.Text>

            <Animated.Text
              style={[
                styles.subtitle,
                { opacity: subOpacity, transform: [{ translateY: subY }] },
              ]}
            >
              A GUIDE TO FINAL LOCATIONS
            </Animated.Text>
          </View>
        </ImageBackground>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1, justifyContent: "center", alignItems: "center" },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.65)" },
  content: { alignItems: "center", paddingHorizontal: 24 },
  logo: { width: 180, height: 220, resizeMode: "contain", marginBottom: 30 },
  title: {
    fontSize: 36,
    letterSpacing: 3,
    color: "#FFFFFF",
    fontWeight: "700",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    letterSpacing: 2,
    color: "#B22222",
    textTransform: "uppercase",
  },
});
