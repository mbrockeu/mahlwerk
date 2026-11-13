// Stand-in pictures for the mock and the demo: drawn plates (shapes on a table), made here from a number. They are NOT photos and not
// anyone's pictures; nothing is fetched. A data: address, so the mock needs no server and the real pages' content security policy is untouched
// (the real app never uses these: it loads api/v1/images/...).
const PALETTES: string[][] = [
  ['#d9c7a3', '#c8402b', '#6e9b4d', '#f2b134', '#f5efe0'], // tomato, basil, cheese
  ['#c9d6c1', '#e8a13a', '#8fb35c', '#f7f0d8', '#b5532a'], // pumpkin, herbs
  ['#e3d3c8', '#d96c8b', '#7da05a', '#f4e7a1', '#8a4b2a'], // berries
  ['#cfd8d2', '#ef8a2c', '#c9f04a', '#f6f3ea', '#3f7a58'], // brand colours
  ['#dccfb8', '#a8532f', '#e2b564', '#7a9b4e', '#f3ecdd'], // baked
];

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A 4:3 picture of a plate with an abstract meal on it, as a data: address. */
export function plate(seed: number): string {
  const r = rng(seed * 7919 + 13);
  const pal = PALETTES[seed % PALETTES.length];
  const [table, a, b, c, rim] = pal;
  const parts: string[] = [];
  const cx = 200 + (r() - 0.5) * 20, cy = 150 + (r() - 0.5) * 10;
  parts.push(`<rect width="400" height="300" fill="${table}"/>`);
  for (let i = 0; i < 9; i++) parts.push(`<rect x="${-20 + i * 50}" y="0" width="22" height="300" fill="#000" opacity="0.025"/>`);
  parts.push(`<ellipse cx="${cx + 6}" cy="${cy + 10}" rx="126" ry="116" fill="#000" opacity="0.16"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="124" fill="${rim}"/><circle cx="${cx}" cy="${cy}" r="102" fill="#fff" opacity="0.55"/>`);
  const colours = [a, b, c, a, b];
  const n = 6 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const ang = r() * Math.PI * 2, dist = r() * 62;
    const x = cx + Math.cos(ang) * dist, y = cy + Math.sin(ang) * dist * 0.9, rad = 14 + r() * 26;
    parts.push(`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${rad.toFixed(1)}" ry="${(rad * (0.7 + r() * 0.3)).toFixed(1)}" fill="${colours[i % colours.length]}" transform="rotate(${Math.floor(r() * 180)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`);
  }
  for (let i = 0; i < 14; i++) {
    const ang = r() * Math.PI * 2, dist = r() * 74;
    parts.push(`<circle cx="${(cx + Math.cos(ang) * dist).toFixed(1)}" cy="${(cy + Math.sin(ang) * dist * 0.9).toFixed(1)}" r="${(2 + r() * 3.5).toFixed(1)}" fill="${colours[(i + 2) % colours.length]}"/>`);
  }
  parts.push(`<rect x="${cx + 138}" y="${cy - 70}" width="14" height="150" rx="7" fill="${rim}" opacity="0.9" transform="rotate(8 ${cx + 145} ${cy})"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">${parts.join('')}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
