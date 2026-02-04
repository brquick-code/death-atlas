import React, { useMemo, useState } from "react";
import { Platform, Pressable, SafeAreaView, Text, View } from "react-native";
import { router } from "expo-router";
import { MapProviderChoice, getDefaultProvider, saveProvider } from "../src/lib/mapProvider";

function ChoiceCard({
  title,
  subtitle,
  selected,
  onPress,
}: {
  title: string;
  subtitle: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        borderRadius: 18,
        padding: 16,
        backgroundColor: selected ? "rgba(220,38,38,0.18)" : "rgba(255,255,255,0.06)",
        borderWidth: 1,
        borderColor: selected ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.10)",
      }}
    >
      <Text style={{ color: "white", fontSize: 18, fontWeight: "900" }}>{title}</Text>
      <Text style={{ color: "rgba(255,255,255,0.70)", marginTop: 6, fontSize: 13 }}>{subtitle}</Text>
    </Pressable>
  );
}

export default function Onboarding() {
  const defaultChoice = useMemo(() => getDefaultProvider(), []);
  const [choice, setChoice] = useState<MapProviderChoice>(defaultChoice);

  const isIOS = Platform.OS === "ios";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "black" }}>
      <View style={{ flex: 1, padding: 18 }}>
        <View style={{ paddingTop: 10 }}>
          <Text style={{ color: "white", fontSize: 30, fontWeight: "900" }}>Death Atlas</Text>
          <Text style={{ color: "rgba(255,255,255,0.65)", marginTop: 8, fontSize: 14 }}>
            Choose your preferred map provider. You can change this later in Settings.
          </Text>
        </View>

        <View style={{ marginTop: 18, gap: 12 }}>
          {isIOS && (
            <ChoiceCard
              title="Apple Maps"
              subtitle="Default on iPhone. Fast and native."
              selected={choice === "apple"}
              onPress={() => setChoice("apple")}
            />
          )}

          <ChoiceCard
            title="Google Maps"
            subtitle={isIOS ? "Optional on iPhone (requires iOS Google Maps setup later)." : "Default on Android."}
            selected={choice === "google"}
            onPress={() => setChoice("google")}
          />
        </View>

        <View style={{ marginTop: "auto", gap: 10 }}>
          <Pressable
            onPress={async () => {
              const finalChoice: MapProviderChoice = Platform.OS === "android" ? "google" : choice;
              await saveProvider(finalChoice);
              router.replace("/");
            }}
            style={{
              borderRadius: 18,
              paddingVertical: 14,
              alignItems: "center",
              backgroundColor: "rgba(220,38,38,0.88)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.12)",
            }}
          >
            <Text style={{ color: "white", fontSize: 16, fontWeight: "900" }}>Continue</Text>
          </Pressable>

          {isIOS && (
            <Text style={{ color: "rgba(255,255,255,0.35)", fontSize: 12, textAlign: "center" }}>
              Note: Google Maps on iOS will require an API key + native config.
            </Text>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
