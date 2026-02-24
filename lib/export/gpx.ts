type LngLatTuple = [number, number];
type LatLngPoint = { lat: number; lng: number };

type RouteInput =
  | GeoJSON.Feature<GeoJSON.LineString>
  | GeoJSON.LineString
  | Array<LngLatTuple | LatLngPoint>;

type RouteToGpxOptions = {
  name?: string;
  description?: string;
  creator?: string;
  timestamps?: Array<string | Date>;
  tupleOrder?: "lnglat" | "latlng";
};

type GpxTrackPoint = {
  lat: number;
  lon: number;
};

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeTuple(
  tuple: LngLatTuple,
  tupleOrder: "lnglat" | "latlng"
): GpxTrackPoint {
  const [a, b] = tuple;
  const lon = tupleOrder === "lnglat" ? a : b;
  const lat = tupleOrder === "lnglat" ? b : a;
  return { lat, lon };
}

function normalizeRoutePoints(
  route: RouteInput,
  tupleOrder: "lnglat" | "latlng" = "lnglat"
): GpxTrackPoint[] {
  let rawPoints: Array<LngLatTuple | LatLngPoint>;
  let effectiveTupleOrder = tupleOrder;

  if (Array.isArray(route)) {
    rawPoints = route;
  } else if ("geometry" in route) {
    rawPoints = route.geometry.coordinates as LngLatTuple[];
    effectiveTupleOrder = "lnglat";
  } else {
    rawPoints = route.coordinates as LngLatTuple[];
    effectiveTupleOrder = "lnglat";
  }

  const points = rawPoints.map((point) => {
    if (Array.isArray(point)) {
      return normalizeTuple(point, effectiveTupleOrder);
    }

    return { lat: point.lat, lon: point.lng };
  });

  for (const point of points) {
    if (!isFiniteNumber(point.lat) || !isFiniteNumber(point.lon)) {
      throw new Error("Route contains invalid coordinates.");
    }
    if (point.lat < -90 || point.lat > 90 || point.lon < -180 || point.lon > 180) {
      throw new Error("Route contains coordinates outside WGS84 bounds.");
    }
  }

  if (points.length < 2) {
    throw new Error("Route must contain at least 2 points to export GPX.");
  }

  return points;
}

function formatTimestamp(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Invalid timestamp provided for GPX export.");
  }
  return date.toISOString();
}

function formatCoord(value: number) {
  return value.toFixed(6);
}

export function routeToGpx(
  route: RouteInput,
  options: RouteToGpxOptions = {}
): string {
  const points = normalizeRoutePoints(route, options.tupleOrder);
  const name = options.name ?? "Run Routr Route";
  const creator = options.creator ?? "Run Routr";
  const timestamps = options.timestamps;

  if (timestamps && timestamps.length !== points.length) {
    throw new Error("GPX timestamps must match the number of route points.");
  }

  const trackPointsXml = points
    .map((point, idx) => {
      const timeXml = timestamps
        ? `<time>${formatTimestamp(timestamps[idx])}</time>`
        : "";
      return `<trkpt lat="${formatCoord(point.lat)}" lon="${formatCoord(point.lon)}">${timeXml}</trkpt>`;
    })
    .join("");

  const descXml = options.description
    ? `<desc>${escapeXml(options.description)}</desc>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${escapeXml(creator)}" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeXml(name)}</name>
    ${descXml}
    <trkseg>${trackPointsXml}</trkseg>
  </trk>
</gpx>
`;
}

export function extractTrackPointsFromGpx(gpx: string): GpxTrackPoint[] {
  const points: GpxTrackPoint[] = [];
  const trkptRegex = /<trkpt\b[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>/g;

  let match: RegExpExecArray | null;
  while ((match = trkptRegex.exec(gpx)) !== null) {
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) continue;
    points.push({ lat, lon });
  }

  return points;
}

type ValidationResult = {
  ok: boolean;
  reason?: string;
};

export function validateGpxTrackMatchesRoute(
  gpx: string,
  route: RouteInput,
  options: { epsilon?: number; tupleOrder?: "lnglat" | "latlng" } = {}
): ValidationResult {
  const expected = normalizeRoutePoints(route, options.tupleOrder);
  const actual = extractTrackPointsFromGpx(gpx);
  const epsilon = options.epsilon ?? 1e-6;

  if (actual.length !== expected.length) {
    return {
      ok: false,
      reason: `Point count mismatch (expected ${expected.length}, got ${actual.length}).`,
    };
  }

  const firstExpected = expected[0];
  const firstActual = actual[0];
  const lastExpected = expected[expected.length - 1];
  const lastActual = actual[actual.length - 1];

  const approxEqual = (a: number, b: number) => Math.abs(a - b) <= epsilon;

  if (
    !approxEqual(firstExpected.lat, firstActual.lat) ||
    !approxEqual(firstExpected.lon, firstActual.lon)
  ) {
    return { ok: false, reason: "First GPX point does not match the route start." };
  }

  if (
    !approxEqual(lastExpected.lat, lastActual.lat) ||
    !approxEqual(lastExpected.lon, lastActual.lon)
  ) {
    return { ok: false, reason: "Last GPX point does not match the route end." };
  }

  return { ok: true };
}

