import React, { useMemo } from "react";
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

function formatDate(d?: string | null) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

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

function isWikipedia(url?: string) {
  return !!url && url.toLowerCase().includes("wikipedia.org");
}

function isOddStops(url?: string) {
  return !!url && url.toLowerCase().includes("oddstops.com");
}

/**
 * Normalize URLs for dedupe:
 * - trim
 * - remove trailing slashes
 * - keep query/fragment
 */
function normUrl(url?: string) {
  if (!url) return "";
  let s = String(url).trim();
  if (!s) return "";
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
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

  const title = firstNonEmpty(item?.name) ?? "Unknown Location";

  const place = firstNonEmpty(item?.place_name);
  const safePlace =
    place && ["person", "unknown", "unknown place"].includes(place.trim().toLowerCase())
      ? undefined
      : place;

  const rawDate = firstNonEmpty(item?.death_date);
  const prettyDate = formatDate(rawDate);

  // ✅ Label the date based on missing vs death
  const isMissing =
    (item?.category ?? "").toLowerCase() === "missing" ||
    (item?.coord_source ?? "").toLowerCase() === "last_seen";

  const dateLabel = isMissing ? "Last seen" : "Died";
  const datePart = prettyDate ? `${dateLabel} • ${prettyDate}` : undefined;

  const subtitleParts = [safePlace, datePart].filter(Boolean) as string[];

  async function openUrl(url?: string) {
    const u = normUrl(url);
    if (!u) return;
    try {
      await Linking.openURL(u);
    } catch {
      // ignore
    }
  }

  const { wikiBtn, sourceBtn, sourceLabel, moreLinks } = useMemo(() => {
    const wiki = normUrl(firstNonEmpty(item?.wikipedia_url));
    const source = normUrl(firstNonEmpty(item?.source_url));
    const moreRaw = (item?.source_urls ?? []).filter(Boolean).map(normUrl).filter(Boolean);

    const uniq = (arr: string[]) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const x of arr) {
        const k = normUrl(x);
        if (!k) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(k);
      }
      return out;
    };

    const moreUniq = uniq(moreRaw);

    let chosenSource = source;

    if (isWikipedia(chosenSource)) {
      const odd = moreUniq.find((u) => isOddStops(u));
      if (odd) chosenSource = odd;
    }

    if (!chosenSource) {
      chosenSource = moreUniq[0] || "";
    }

    const label = sourceLabelFromUrl(chosenSource);

    const exclude = new Set<string>();
    if (wiki) exclude.add(normUrl(wiki));
    if (chosenSource) exclude.add(normUrl(chosenSource));

    const moreCombined: string[] = [];

    if (source && !exclude.has(normUrl(source))) moreCombined.push(source);

    for (const u of moreUniq) {
      if (!exclude.has(normUrl(u))) moreCombined.push(u);
    }

    const moreFinal = uniq(moreCombined).slice(0, 10);

    return {
      wikiBtn: wiki || undefined,
      sourceBtn: chosenSource || undefined,
      sourceLabel: label,
      moreLinks: moreFinal,
    };
  }, [item]);

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
                <Text style={styles.subtitle} numberOfLines={3}>
                  {subtitleParts.join("\n")}
                </Text>
              ) : null}
            </View>

            <Pressable onPress={onClose} style={styles.xBtn}>
              <Text style={styles.xText}>✕</Text>
            </Pressable>
          </View>

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
              disabled={!wikiBtn}
              onPress={() => openUrl(wikiBtn)}
              style={({ pressed }) => [styles.bigBtn, !wikiBtn && styles.disabledBtn, pressed && styles.pressed]}
            >
              <Text style={styles.bigBtnText}>Wikipedia</Text>
            </Pressable>

            <Pressable
              disabled={!sourceBtn}
              onPress={() => openUrl(sourceBtn)}
              style={({ pressed }) => [styles.bigBtn, !sourceBtn && styles.disabledBtn, pressed && styles.pressed]}
            >
              <Text style={styles.bigBtnText}>{sourceLabel}</Text>
            </Pressable>
          </View>

          {moreLinks.length ? (
            <View style={styles.moreWrap}>
              <Text style={styles.moreTitle}>More links</Text>

              {moreLinks.map((u, i) => (
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
  subtitle: { color: "rgba(255,255,255,0.72)", marginTop: 6, fontWeight: "700", lineHeight: 18 },

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
