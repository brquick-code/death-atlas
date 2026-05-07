import L from "leaflet";

function svgPin(color: string) {
  return `
<svg width="32" height="48" viewBox="0 0 32 48" xmlns="http://www.w3.org/2000/svg">
  <path
    d="M16 0C7.16 0 0 7.16 0 16c0 11.05 16 32 16 32s16-20.95 16-32C32 7.16 24.84 0 16 0z"
    fill="${color}"
  />
  <circle cx="16" cy="16" r="6" fill="#fff"/>
</svg>
`;
}

function makeIcon(color: string) {
  return L.divIcon({
    className: "",
    html: svgPin(color),
    iconSize: [32, 48],
    iconAnchor: [16, 48],   // point of the pin
    popupAnchor: [0, -44],
  });
}

export const deathIcon = makeIcon("#d32f2f");   // red
export const burialIcon = makeIcon("#1976d2"); // blue
export const unknownIcon = makeIcon("#757575"); // gray
