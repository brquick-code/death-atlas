export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function latLngToTileXY(lat: number, lng: number, z: number) {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, z);
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

export function tileXYToBounds(x: number, y: number, z: number) {
  const n = Math.pow(2, z);

  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;

  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));

  const north = (northRad * 180) / Math.PI;
  const south = (southRad * 180) / Math.PI;

  return { south, west, north, east };
}

export function tilesCoveringBounds(
  bounds: { north: number; south: number; east: number; west: number },
  z: number,
  ring = 0
) {
  const { north, south, east, west } = bounds;

  const t1 = latLngToTileXY(north, west, z);
  const t2 = latLngToTileXY(south, east, z);

  let minX = Math.min(t1.x, t2.x) - ring;
  let maxX = Math.max(t1.x, t2.x) + ring;
  let minY = Math.min(t1.y, t2.y) - ring;
  let maxY = Math.max(t1.y, t2.y) + ring;

  const n = Math.pow(2, z);
  minX = clamp(minX, 0, n - 1);
  maxX = clamp(maxX, 0, n - 1);
  minY = clamp(minY, 0, n - 1);
  maxY = clamp(maxY, 0, n - 1);

  const out: Array<{ x: number; y: number }> = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) out.push({ x, y });
  }
  return out;
}

export function tileKey(z: number, x: number, y: number) {
  return `${z}/${x}/${y}`;
}
