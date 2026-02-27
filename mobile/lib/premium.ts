// mobile/lib/premium.ts
import { useEffect, useState } from "react";

/**
 * Shared premium state across tabs/screens.
 * Also exports initRevenueCat() because app/_layout.tsx calls it.
 */

type Listener = () => void;

type PremiumStore = {
  isPremium: boolean;
  hydrated: boolean;
  listeners: Set<Listener>;
  emit: () => void;
  setPremium: (v: boolean) => void;
  subscribe: (fn: Listener) => () => void;
};

const STORE_KEY = "__death_atlas_premium_store_v1__";
const STORAGE_KEY = "death_atlas_is_premium_v1";

// Change this if your RC entitlement id is different.
// If it’s wrong, we still accept “any active entitlement”.
const ENTITLEMENT_ID = "premium";
// ✅ DEV-only premium bypass (works in Expo Go)
// Turn on by setting: EXPO_PUBLIC_DEV_PREMIUM=1 in mobile/.env
const DEV_PREMIUM_BYPASS = __DEV__ && process.env.EXPO_PUBLIC_DEV_PREMIUM === "1";

const store: PremiumStore =
  (globalThis as any)[STORE_KEY] ??
  ((globalThis as any)[STORE_KEY] = {
    isPremium: false,
    hydrated: false,
    listeners: new Set<Listener>(),
    emit() {
      for (const fn of this.listeners) fn();
    },
    setPremium(v: boolean) {
      const next = !!v;
      if (this.isPremium === next) return;
      this.isPremium = next;
      this.emit();
      void persistPremium(next);
    },
    subscribe(fn: Listener) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
  });

async function loadAsyncStorage() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@react-native-async-storage/async-storage");
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

async function persistPremium(val: boolean) {
  try {
    const AsyncStorage = await loadAsyncStorage();
    if (!AsyncStorage) return;
    await AsyncStorage.setItem(STORAGE_KEY, val ? "1" : "0");
  } catch {}
}

async function readPersistedPremium(): Promise<boolean | null> {
  try {
    const AsyncStorage = await loadAsyncStorage();
    if (!AsyncStorage) return null;
    const v = await AsyncStorage.getItem(STORAGE_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
    return null;
  } catch {
    return null;
  }
}

async function loadPurchases() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("react-native-purchases");
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

function premiumFromCustomerInfo(info: any): boolean {
  if (!info) return false;

  const active = info?.entitlements?.active;
  if (active && typeof active === "object") {
    if (active[ENTITLEMENT_ID]) return true;
    if (Object.keys(active).length > 0) return true; // fallback: any active entitlement
  }

  const subs = info?.activeSubscriptions;
  if (Array.isArray(subs) && subs.length > 0) return true;

  return false;
}

/**
 * ✅ Called from app/_layout.tsx
 * Safe: does nothing if Purchases isn’t available in this build.
 *
 * Expects ONE of these env vars (set whichever you use):
 * - EXPO_PUBLIC_REVENUECAT_API_KEY_IOS
 * - EXPO_PUBLIC_REVENUECAT_API_KEY_ANDROID
 * - EXPO_PUBLIC_REVENUECAT_API_KEY (fallback)
 */
export async function initRevenueCat() {
  try {
    const Purchases = await loadPurchases();
    if (!Purchases) return;

    // Only configure once
    if ((globalThis as any).__death_atlas_rc_inited__) return;
    (globalThis as any).__death_atlas_rc_inited__ = true;

    const Platform = require("react-native").Platform;

    const iosKey =
      process.env.EXPO_PUBLIC_REVENUECAT_API_KEY_IOS ||
      process.env.EXPO_PUBLIC_REVENUECAT_API_KEY ||
      "";

    const androidKey =
      process.env.EXPO_PUBLIC_REVENUECAT_API_KEY_ANDROID ||
      process.env.EXPO_PUBLIC_REVENUECAT_API_KEY ||
      "";

    const apiKey = Platform.OS === "ios" ? iosKey : androidKey;
    if (!apiKey) {
      // No key set; don’t crash — just skip init.
      return;
    }

    if (typeof Purchases.configure === "function") {
      Purchases.configure({ apiKey });
    }

    // Optional: keep state fresh on startup
    await refreshPremium();
  } catch {
    // swallow — init should NEVER crash the app
  }
}

export async function refreshPremium(): Promise<boolean> {
  if (DEV_PREMIUM_BYPASS) {
    store.isPremium = true;
    store.hydrated = true;
    store.emit();
    return true;
  }

  // one-time hydrate from storage (instant UI)
  if (!store.hydrated) {
    store.hydrated = true;
    const persisted = await readPersistedPremium();
    if (persisted !== null) {
      store.isPremium = persisted;
      store.emit();
    }
  }

  // best-effort RC check
  try {
    const Purchases = await loadPurchases();
    if (Purchases?.getCustomerInfo) {
      const info = await Purchases.getCustomerInfo();
      store.setPremium(premiumFromCustomerInfo(info));
    }
  } catch {}

  return store.isPremium;
}

export function usePremium() {
  const [isPremium, setIsPremium] = useState(DEV_PREMIUM_BYPASS ? true : store.isPremium);

  useEffect(() => {
    const unsub = store.subscribe(() => setIsPremium(DEV_PREMIUM_BYPASS ? true : store.isPremium));
    void refreshPremium();
    return unsub;
  }, []);

  async function startPurchase() {
    const Purchases = await loadPurchases();
    if (!Purchases) {
      await refreshPremium();
      return;
    }

    // Offerings -> buy first available pkg (annual/monthly/etc.)
    if (Purchases.getOfferings && Purchases.purchasePackage) {
      const offerings = await Purchases.getOfferings();
      const current = offerings?.current;

      const pkg =
        current?.annual ??
        current?.monthly ??
        current?.lifetime ??
        current?.availablePackages?.[0] ??
        null;

      if (!pkg) {
        await refreshPremium();
        return;
      }

      const res = await Purchases.purchasePackage(pkg);
      const info = res?.customerInfo ?? res;
      store.setPremium(premiumFromCustomerInfo(info));
      return;
    }

    await refreshPremium();
  }

  async function restore() {
    const Purchases = await loadPurchases();
    if (!Purchases?.restorePurchases) {
      await refreshPremium();
      return;
    }

    const info = await Purchases.restorePurchases();
    store.setPremium(premiumFromCustomerInfo(info));
  }

  return { isPremium, startPurchase, restore };
}