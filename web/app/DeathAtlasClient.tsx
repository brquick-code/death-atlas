"use client";

import dynamic from "next/dynamic";

const DeathAtlasMap = dynamic(
  () => import("./components/DeathAtlasMap"),
  { ssr: false }
);

export default function DeathAtlasClient() {
  return <DeathAtlasMap />;
}
