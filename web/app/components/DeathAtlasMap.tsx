"use client";

import dynamic from "next/dynamic";
import React from "react";

const MapClient = dynamic(() => import("./MapClient"), { ssr: false });

type Props = {
  className?: string;
  initialCenter?: [number, number];
  initialZoom?: number;
  assumeRawPoints?: boolean;
  minZoom?: number;
  maxZoom?: number;
};

export default function DeathAtlasMap({
  className,
  initialCenter,
  initialZoom,
  assumeRawPoints,
  minZoom,
  maxZoom,
}: Props) {
  // If caller doesn't provide sizing via className, guarantee a visible map.
  const wrapperStyle: React.CSSProperties = className
    ? {}
    : { width: "100%", height: "100vh", minHeight: 600 };

  return (
    <div className={className} style={wrapperStyle}>
      <MapClient
        // If Tailwind isn't guaranteeing height, inline style in MapClient will still work.
        initialCenter={initialCenter}
        initialZoom={initialZoom}
        assumeRawPoints={assumeRawPoints}
        minZoom={minZoom}
        maxZoom={maxZoom}
      />
    </div>
  );
}
