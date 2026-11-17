/** Light wash of a bot profile color. Empty color uses the same seed hash as BotFace. */
const FILL = 0.86;
const EDGE = 0.68;

function mixWhite(channel: number, toward: number) {
  return Math.round(channel + (255 - channel) * toward);
}

function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
  if (!match) return null;
  const body = match[1].length === 3 ? match[1].split("").map((c) => c + c).join("") : match[1];
  const n = Number.parseInt(body, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: [number, number, number]) {
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function faceHue(seed: string) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function lightUserHighlight(color: string | undefined, seed: string): { bg: string; border: string } {
  const rgb = color ? parseHex(color) : null;
  if (!rgb) {
    const hue = faceHue(seed || "bot");
    return { bg: `hsl(${hue} 75% 90%)`, border: `hsl(${hue} 48% 78%)` };
  }
  const tint = (toward: number): [number, number, number] => [
    mixWhite(rgb[0], toward),
    mixWhite(rgb[1], toward),
    mixWhite(rgb[2], toward),
  ];
  return { bg: toHex(tint(FILL)), border: toHex(tint(EDGE)) };
}
