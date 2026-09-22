// Vendored from the product's own UI package (brand/color).
// Shade derivation shared by the brand surfaces (logo ramps, decorative wash). Pure data, no
// platform imports.
//
// Shades move in HSL (hue + saturation preserved, only lightness moves). Mixing toward black/white
// instead would desaturate and muddy warm hues — a darkened orange turned brown.
// Inputs/outputs are 6-digit #rrggbb.

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const ch = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${ch(r)}${ch(g)}${ch(b)}`.toUpperCase();
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let u = t;
    if (u < 0) u += 1;
    if (u > 1) u -= 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}

function withLightness(hex: string, fn: (l: number) => number): string {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  return rgbToHex(...hslToRgb(h, s, fn(l)));
}

/** Moves `hex` `t` (0-1) of the way toward full lightness, keeping its hue and saturation. */
export const lighten = (hex: string, t: number) => withLightness(hex, (l) => l + (1 - l) * t);

/** Moves `hex` `t` (0-1) of the way toward black, keeping its hue and saturation. */
export const darken = (hex: string, t: number) => withLightness(hex, (l) => l * (1 - t));
