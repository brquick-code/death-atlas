import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "deathAtlas_hasSeenOpening_v1";

export async function hasSeenOpening(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    return v === "1";
  } catch {
    return false;
  }
}

export async function markSeenOpening(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, "1");
  } catch {
    // ignore
  }
}
