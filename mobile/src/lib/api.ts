// C:\death-atlas\mobile\src\lib\api.ts
import { Platform } from "react-native";

/**
 * IMPORTANT:
 * - On a physical phone (Expo Go), "localhost" points to the phone, NOT your PC.
 * - Best practice is to set EXPO_PUBLIC_API_BASE_URL to your PC's LAN IP, e.g.:
 *     EXPO_PUBLIC_API_BASE_URL=http://192.168.1.42:3000
 */
function normalizeBaseUrl(u: string) {
  return u.replace(/\/$/, "");
}

function defaultDevBaseUrl() {
  // Android emulator special alias for host machine:
  // https://developer.android.com/studio/run/emulator-networking
  if (Platform.OS === "android") return "http://10.0.2.2:3000";

  // iOS simulator can reach localhost
  if (Platform.OS === "ios") return "http://localhost:3000";

  // Real devices: cannot safely guess. Force user to set env var.
  // We'll still return localhost so the app runs, but callers should see the warning.
  return "http://localhost:3000";
}

export const API_BASE = normalizeBaseUrl(
  process.env.EXPO_PUBLIC_API_BASE_URL?.trim() || defaultDevBaseUrl()
);

export function apiBaseNeedsDeviceOverride() {
  const isLikelyLocalhost =
    API_BASE.includes("localhost") || API_BASE.includes("127.0.0.1");

  // On web/native, we only care about real device cases.
  // Expo Go on a real device typically hits this: Platform.OS is "ios" or "android",
  // but the special emulator routing only works on emulators.
  // We can't detect emulator reliably without extra libs, so we show the warning
  // whenever API_BASE is localhost on native.
  return Platform.OS !== "web" && isLikelyLocalhost;
}

export async function apiGetJson<T>(
  path: string,
  signal?: AbortSignal
): Promise<T> {
  const url = `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;

  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}
