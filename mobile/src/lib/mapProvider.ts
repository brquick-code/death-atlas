import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

export type MapProviderChoice = "apple" | "google";

const KEY = "deathatlas.mapProviderChoice.v1";

export function getDefaultProvider(): MapProviderChoice {
  if (Platform.OS === "android") return "google";
  return "apple";
}

export async function getSavedProvider(): Promise<MapProviderChoice | null> {
  const v = await AsyncStorage.getItem(KEY);
  if (v === "apple" || v === "google") return v;
  return null;
}

export async function saveProvider(v: MapProviderChoice): Promise<void> {
  await AsyncStorage.setItem(KEY, v);
}

export async function clearProvider(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
