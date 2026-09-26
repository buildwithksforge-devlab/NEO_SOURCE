/**
 * Canonical NEØ document artwork.
 *
 * The printed page carries one decorative element: a black geometric wireframe
 * sphere cropped into the upper-right corner. The geometry lives here as plain
 * numbers so the on-screen SVG and the server-rendered PDF draw the *same*
 * drawing — one is never a re-interpretation of the other, and neither is a
 * flattened bitmap, so the page stays vector-crisp, searchable and printable.
 *
 * Coordinates are on a 0..1 unit square. The consumer scales and crops.
 */

export type Point = { x: number; y: number };

/** Vertices of the wireframe globe, on the unit square. */
export const WIREFRAME_POINTS: Point[] = (() => {
  const points: Point[] = [];
  const rings = [0.16, 0.34, 0.52, 0.7, 0.86];
  const counts = [6, 9, 11, 9, 6];
  rings.forEach((radius, ringIndex) => {
    const count = counts[ringIndex] ?? 8;
    // A fixed offset per ring keeps the mesh irregular — as in the reference —
    // while staying fully deterministic (no randomness in a printed document).
    const offset = ringIndex * 0.37;
    for (let i = 0; i < count; i += 1) {
      const angle = offset + (i / count) * Math.PI * 2;
      points.push({
        x: 0.5 + radius * Math.cos(angle),
        y: 0.5 + radius * Math.sin(angle) * 0.94,
      });
    }
  });
  points.push({ x: 0.5, y: 0.5 });
  return points;
})();

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Edges of the mesh: every vertex joins its nearest neighbours, plus long
 * chords across the sphere. Deterministic — the same document always prints
 * the identical drawing.
 */
export const WIREFRAME_EDGES: [number, number][] = (() => {
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (a === b || seen.has(key)) return;
    seen.add(key);
    edges.push([a, b]);
  };
  WIREFRAME_POINTS.forEach((point, index) => {
    const neighbours = WIREFRAME_POINTS.map((other, otherIndex) => ({
      otherIndex,
      d: distance(point, other),
    }))
      .filter((n) => n.otherIndex !== index)
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    neighbours.forEach((n) => add(index, n.otherIndex));
  });
  // Long chords through the centre give the reference drawing its depth.
  const centre = WIREFRAME_POINTS.length - 1;
  for (let i = 0; i < WIREFRAME_POINTS.length - 1; i += 2) add(i, centre);
  return edges;
})();

/** Absolute line segments for a given box, ready for SVG or pdf-lib. */
export function wireframeSegments(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x1: number; y1: number; x2: number; y2: number }[] {
  return WIREFRAME_EDGES.map(([a, b]) => {
    const pa = WIREFRAME_POINTS[a] as Point;
    const pb = WIREFRAME_POINTS[b] as Point;
    return {
      x1: box.x + pa.x * box.width,
      y1: box.y + pa.y * box.height,
      x2: box.x + pb.x * box.width,
      y2: box.y + pb.y * box.height,
    };
  });
}

/** The warm-brown accent of the reference design, used for the title block and total bar. */
export const DOCUMENT_BROWN = "#6F4636";
export const DOCUMENT_INK = "#111111";
