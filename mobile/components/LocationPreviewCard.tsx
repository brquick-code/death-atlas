import React from "react";
import { Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";

type DeathLocation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;

  place_name?: string;
  category?: string;
  death_date?: string;

  wikipedia_url?: string;
  source_url?: string;
  source_urls?: string[];

  confidence?: string;
  coord_source?: string;
};

function sourceLabelFromUrl(url?: string) {
  if (!url) return "Source";

  const u = url.toLowerCase();

  if (u.includes("oddstops.com")) return "OddStops";
  if (u.includes("findadeath.com")) return "Find A Death";
  if (u.includes("findagrave.com")) return "Find A Grave";
  if (u.includes("wikipedia.org")) return "Wikipedia";

  // optional extras
  if (u.includes("imdb.com")) return "IMDb";
  if (u.includes("newspapers.com")) return "Newspapers.com";

  return "Source";
}

function firstNonEmpty(...vals: any[]): string | undefined {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s.length) return s;
  }
  return undefined;
}

export default function LocationPreviewCard({
  visible,
  item,
  onClose,
  onDirections,
}: {
  visible: boolean;
  item: DeathLocation | null;
  onClose: () => void;
  onDirections?: (item: DeathLocation) => void;
}) {
  if (!visible) return null;

  // ✅ title should be the person's name (don't fall back to place_name)
  const title = firstNonEmpty(item?.name) ?? "Unknown Location";

  // ✅ only show a meaningful place (never show "person"/"unknown")
  const place = firstNonEmpty(item?.place_name);
  const safePlace =
    place && ["person", "unknown", "unknown place"].includes(place.trim().toLowerCase()) ? undefined : place;

  const deathDate = firstNonEmpty(item?.death_date);

  // ✅ remove category entirely (this was showing "person")
  const subtitleParts = [safePlace, deathDate].filter(Boolean) as string[];

  const wiki = firstNonEmpty(item?.wikipedia_url);
  const source = firstNonEmpty(item?.source_url);
  const more = (item?.source_urls ?? []).filter(Boolean).slice(0, 10);

  async function openUrl(url?: string) {
    if (!url) return;
    try {
      await Linking.openURL(url);
    } catch {
      // ignore
    }
  }

  const sourceLabel = sourceLabelFromUrl(source);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />

      <View style={styles.wrap}>
        <View style={styles.card}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title} numberOfLines={2}>
                {title}
              </Text>
              {subtitleParts.length ? (
                <Text style={styles.subtitle} numberOfLines={2}>
                  {subtitleParts.join(" • ")}
                </Text>
              ) : null}
            </View>

            <Pressable onPress={onClose} style={styles.xBtn}>
              <Text style={styles.xText}>✕</Text>
            </Pressable>
          </View>

          {/* ✅ Directions button */}
          {onDirections && item ? (
            <Pressable
              onPress={() => onDirections(item)}
              style={({ pressed }) => [styles.dirBtn, pressed && styles.pressed]}
            >
              <Text style={styles.dirBtnText}>Directions</Text>
            </Pressable>
          ) : null}

          <View style={styles.btnRow}>
            <Pressable
              disabled={!wiki}
              onPress={() => openUrl(wiki)}
              style={({ pressed }) => [styles.bigBtn, !wiki && styles.disabledBtn, pressed && styles.pressed]}
            >
              <Text style={styles.bigBtnText}>Wikipedia</Text>
            </Pressable>

            <Pressable
              disabled={!source}
              onPress={() => openUrl(source)}
              style={({ pressed }) => [styles.bigBtn, !source && styles.disabledBtn, pressed && styles.pressed]}
            >
              <Text style={styles.bigBtnText}>{sourceLabel}</Text>
            </Pressable>
          </View>

          {more.length ? (
            <View style={styles.moreWrap}>
              <Text style={styles.moreTitle}>More links</Text>

              {more.map((u, i) => (
                <Pressable
                  key={`${u}-${i}`}
                  onPress={() => openUrl(u)}
                  style={({ pressed }) => [styles.smallLink, pressed && styles.pressed]}
                >
                  <Text style={styles.smallLinkText} numberOfLines={1}>
                    {sourceLabelFromUrl(u)}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: Platform.OS === "ios" ? 28 : 18,
    paddingHorizontal: 14,
  },
  card: {
    borderRadius: 18,
    padding: 14,
    backgroundColor: "rgba(12, 14, 18, 0.95)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  title: { color: "white", fontWeight: "900", fontSize: 18 },
  subtitle: { color: "rgba(255,255,255,0.72)", marginTop: 6, fontWeight: "700" },

  xBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  xText: { color: "white", fontWeight: "900", fontSize: 14 },

  // ✅ Directions button (subtle, matches your style)
  dirBtn: {
    marginTop: 12,
    height: 44,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  dirBtnText: { color: "white", fontWeight: "900" },

  btnRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  bigBtn: {
    flex: 1,
    height: 44,
    borderRadius: 14,
    backgroundColor: "rgba(220,38,38,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  bigBtnText: { color: "white", fontWeight: "900" },
  disabledBtn: { opacity: 0.35 },

  moreWrap: { marginTop: 12 },
  moreTitle: { color: "rgba(255,255,255,0.85)", fontWeight: "900", marginBottom: 8 },
  smallLink: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  smallLinkText: { color: "#e5e7eb", fontSize: 12 },

  pressed: { opacity: 0.85 },
});
