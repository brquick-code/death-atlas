import { Tabs } from "expo-router";
import { View, Text } from "react-native";

function TabIcon({ label, active }: { label: string; active: boolean }) {
  return (
    <View style={{ alignItems: "center", gap: 4 }}>
      <View
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          backgroundColor: active ? "#DC2626" : "rgba(255,255,255,0.25)",
        }}
      />
      <Text style={{ color: active ? "#fff" : "rgba(255,255,255,0.65)", fontSize: 11, fontWeight: "700" }}>
        {label}
      </Text>
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "rgba(10,12,16,0.98)",
          borderTopColor: "rgba(255,255,255,0.10)",
          borderTopWidth: 1,
          height: 74,
          paddingTop: 10,
          paddingBottom: 16,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Explore",
          tabBarLabel: () => null,
          tabBarIcon: ({ focused }) => <TabIcon label="Explore" active={focused} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Search",
          tabBarLabel: () => null,
          tabBarIcon: ({ focused }) => <TabIcon label="Search" active={focused} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarLabel: () => null,
          tabBarIcon: ({ focused }) => <TabIcon label="Profile" active={focused} />,
        }}
      />
    </Tabs>
  );
}
