import { NextResponse } from "next/server";

const RUN_PACE_MIN_PER_KM = 6; // assumed running pace for estimates

type MapboxStep = {
  name?: string;
  distance?: number;
  duration?: number;
  maneuver?: {
    instruction?: string;
    location?: [number, number];
    type?: string;
    modifier?: string;
  };
};

type MapboxLeg = {
  steps?: MapboxStep[];
};

type MapboxRoute = {
  distance: number;
  geometry: {
    coordinates: [number, number][];
  };
  legs?: MapboxLeg[];
};

type DirectionsResponse = {
  routes?: MapboxRoute[];
};

type RouteStep = {
  instruction: string;
  distance_m: number;
  duration_s: number;
  location: [number, number] | null;
  type: string | null;
  modifier: string | null;
  name: string | null;
};

function metersToKm(m: number) {
  return m / 1000;
}

function distanceMeters(a: [number, number], b: [number, number]) {
  const R = 6371000; // meters
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function snapCoord(value: number, precision: number) {
  return (Math.round(value / precision) * precision).toFixed(5);
}

function segmentKey(
  a: [number, number],
  b: [number, number],
  precision = 0.0002 // ~20m
) {
  const aKey = `${snapCoord(a[0], precision)},${snapCoord(a[1], precision)}`;
  const bKey = `${snapCoord(b[0], precision)},${snapCoord(b[1], precision)}`;
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

function getRouteOverlapPenaltyKm(route: MapboxRoute) {
  const coords = route.geometry?.coordinates ?? [];
  if (coords.length < 3) return 0;

  const seenSegments = new Set<string>();
  let totalMeters = 0;
  let overlapMeters = 0;

  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const segmentMeters = distanceMeters(prev, curr);
    if (segmentMeters < 5) continue;

    totalMeters += segmentMeters;
    const key = segmentKey(prev, curr);

    if (seenSegments.has(key)) {
      overlapMeters += segmentMeters;
    } else {
      seenSegments.add(key);
    }
  }

  if (totalMeters <= 0) return 0;

  const overlapRatio = overlapMeters / totalMeters;
  // Convert overlap fraction to km-equivalent penalty for the scorer.
  return overlapRatio * 1.2;
}

function isGenericPathName(name: string | null) {
  if (!name) return true;
  const normalized = name.trim().toLowerCase();
  if (!normalized) return true;

  const genericTerms = [
    "walkway",
    "crosswalk",
    "sidewalk",
    "path",
    "trail",
    "footway",
    "pedestrian",
    "steps",
    "stair",
    "bridge",
  ];

  return genericTerms.some((term) => normalized.includes(term));
}

function toSentence(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "Continue.";
  if (/[.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}

function formatInstruction(step: MapboxStep) {
  const maneuverType = step.maneuver?.type ?? null;
  const modifier = step.maneuver?.modifier ?? null;
  const stepName = step.name?.trim() || null;
  const raw = step.maneuver?.instruction?.trim() || "";
  const hasSpecificName = !!stepName && !isGenericPathName(stepName);

  if (maneuverType === "arrive") return "You have arrived at your destination.";

  if (hasSpecificName && maneuverType === "turn" && modifier) {
    return `Turn ${modifier} onto ${stepName}.`;
  }

  if (hasSpecificName && (maneuverType === "fork" || maneuverType === "merge") && modifier) {
    return `Keep ${modifier} onto ${stepName}.`;
  }

  if (hasSpecificName && maneuverType === "depart" && modifier) {
    return `Head ${modifier} on ${stepName}.`;
  }

  if (hasSpecificName && raw && !raw.toLowerCase().includes(stepName.toLowerCase())) {
    return toSentence(`${raw} onto ${stepName}`);
  }

  return toSentence(raw || "Continue");
}

function isCoreManeuverType(type: string | null) {
  if (!type) return false;

  return (
    type === "depart" ||
    type === "arrive" ||
    type === "turn" ||
    type === "fork" ||
    type === "merge" ||
    type === "roundabout" ||
    type === "rotary" ||
    type === "roundabout turn" ||
    type === "end of road"
  );
}

function simplifyRouteSteps(steps: RouteStep[]) {
  if (steps.length <= 2) return steps;

  const lastIdx = steps.length - 1;

  const filtered = steps.filter((step, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === lastIdx;
    const isDepart = step.type === "depart";
    const isArrive = step.type === "arrive";
    const isCore = isCoreManeuverType(step.type);
    const hasSpecificName = !!step.name && !isGenericPathName(step.name);
    const hasGenericName = !!step.name && isGenericPathName(step.name);

    if (isFirst || isLast) return true;
    if (isDepart || isArrive) return false; // remove waypoint boundary noise

    // Drop near-zero connector steps unless this is the final instruction.
    if (step.distance_m < 8) return false;

    // Keep meaningful named-road maneuvers even if shorter.
    if (hasSpecificName && isCore && step.distance_m >= 20) return true;

    // Hide short generic path instructions (walkway/crosswalk/etc).
    if (hasGenericName && step.distance_m < 140) return false;

    // Hide tiny turn instructions unless they involve a specific road name.
    if (!hasSpecificName && isCore && step.distance_m < 45) return false;

    // Non-core guidance must cover a reasonable stretch to be useful.
    if (!isCore && step.distance_m < 220) return false;

    return true;
  });

  const merged: RouteStep[] = [];
  for (const step of filtered) {
    const lastMerged = merged[merged.length - 1];
    if (
      lastMerged &&
      lastMerged.instruction.trim().toLowerCase() ===
        step.instruction.trim().toLowerCase() &&
      lastMerged.type === step.type &&
      lastMerged.modifier === step.modifier
    ) {
      lastMerged.distance_m += step.distance_m;
      lastMerged.duration_s += step.duration_s;
      continue;
    }

    // De-noise tiny left/right zig-zags on unnamed connectors.
    const previousStep = merged[merged.length - 1];
    const prevDir = previousStep?.modifier?.includes("left")
      ? "left"
      : previousStep?.modifier?.includes("right")
        ? "right"
        : null;
    const currDir = step.modifier?.includes("left")
      ? "left"
      : step.modifier?.includes("right")
        ? "right"
        : null;
    const isOppositeZigZag =
      previousStep &&
      previousStep.type === "turn" &&
      step.type === "turn" &&
      prevDir &&
      currDir &&
      prevDir !== currDir &&
      (previousStep.distance_m ?? 0) <= 70 &&
      (step.distance_m ?? 0) <= 70 &&
      isGenericPathName(previousStep.name) &&
      isGenericPathName(step.name);

    if (isOppositeZigZag) {
      previousStep.distance_m += step.distance_m;
      previousStep.duration_s += step.duration_s;
      previousStep.instruction = "Continue straight.";
      previousStep.type = null;
      previousStep.modifier = null;
      previousStep.name = null;
      continue;
    }

    merged.push({ ...step });
  }

  return merged;
}

function getRouteSmoothnessPenaltyKm(route: MapboxRoute) {
  const steps = route.legs?.flatMap((leg) => leg.steps || []) ?? [];

  let shortTurnCount = 0;
  let totalTurnCount = 0;

  for (const step of steps) {
    const maneuverType = step?.maneuver?.type ?? "";
    const isTurnLike =
      maneuverType.includes("turn") ||
      maneuverType === "fork" ||
      maneuverType === "roundabout";

    if (!isTurnLike) continue;

    totalTurnCount += 1;
    if ((step?.distance ?? 0) < 45) {
      shortTurnCount += 1;
    }
  }

  // Convert maneuver complexity into a km-equivalent cost so distance can still dominate.
  // Short turns are penalized more heavily than regular turns.
  return shortTurnCount * 0.12 + totalTurnCount * 0.015;
}

function scoreRoute(route: MapboxRoute, targetKm: number) {
  const routeKm = metersToKm(route.distance ?? 0);
  const distanceDiffKm = Math.abs(routeKm - targetKm);
  const smoothnessPenaltyKm = getRouteSmoothnessPenaltyKm(route);
  const overlapPenaltyKm = getRouteOverlapPenaltyKm(route);

  return {
    routeKm,
    distanceDiffKm,
    smoothnessPenaltyKm,
    overlapPenaltyKm,
    score: distanceDiffKm + smoothnessPenaltyKm + overlapPenaltyKm,
  };
}

// Rough conversion: 1 degree latitude ~ 111km, using spherical earth formula
function destinationPoint(
  lat: number,
  lng: number,
  bearingDeg: number,
  distanceKm: number
) {
  const R = 6371; // km
  const bearing = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lng * Math.PI) / 180;

  const δ = distanceKm / R;

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) +
      Math.cos(φ1) * Math.sin(δ) * Math.cos(bearing)
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );

  return {
    lat: (φ2 * 180) / Math.PI,
    lng: ((λ2 * 180) / Math.PI + 540) % 360 - 180, // normalize to [-180, 180]
  };
}

async function fetchDirections(
  coords: Array<{ lng: number; lat: number }>,
  token: string
): Promise<DirectionsResponse> {
  const coordStr = coords.map((c) => `${c.lng},${c.lat}`).join(";");
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordStr}` +
    `?geometries=geojson&overview=full&steps=true&access_token=${token}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Directions API error: ${res.status}`);
  return res.json();
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const km = Number(searchParams.get("km"));

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(km)) {
    return NextResponse.json({ error: "Invalid params" }, { status: 400 });
  }

  const token = process.env.MAPBOX_SECRET_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "Missing MAPBOX_SECRET_TOKEN" },
      { status: 500 }
    );
  }

  const start = { lat, lng };
  const targetKm = km;

  // Try a few bearings, and for each one, tune the waypoint radius to match targetKm.
  // The winner balances distance accuracy and smoother, less turn-dense paths.
  const bearingTries = 9;
  const tuneSteps = 6;
  const toleranceKm = 0.5;

  let best: MapboxRoute | null = null;
  let bestScore = Infinity;

  for (let t = 0; t < bearingTries; t++) {
    const b1 = Math.random() * 360;
    const b2 = (b1 + 95 + Math.random() * 90) % 360;
    const useThreeWaypoints = Math.random() < 0.7;
    const b3 = (b2 + 80 + Math.random() * 80) % 360;
    const leg2Scale = 0.8 + Math.random() * 0.35;
    const leg3Scale = 0.65 + Math.random() * 0.35;

    // Start with a smaller guess than before (roads add distance)
    // These bounds keep it stable for short/long runs.
    let low = targetKm * 0.12;
    let high = targetKm * 0.45;
    let leg = targetKm * 0.22;

    for (let s = 0; s < tuneSteps; s++) {
      const wp1 = destinationPoint(start.lat, start.lng, b1, leg);
      const wp2 = destinationPoint(start.lat, start.lng, b2, leg * leg2Scale);
      const coords = useThreeWaypoints
        ? [
            start,
            wp1,
            wp2,
            destinationPoint(start.lat, start.lng, b3, leg * leg3Scale),
            start,
          ]
        : [start, wp1, wp2, start];

      try {
        const data = await fetchDirections(coords, token);
        const route = data?.routes?.[0];
        if (!route) continue;

        const { routeKm, distanceDiffKm, score } = scoreRoute(route, targetKm);

        if (score < bestScore) {
          bestScore = score;
          best = route;
        }

        if (distanceDiffKm <= toleranceKm) break;

        // If route too long, shrink leg; if too short, expand leg
        if (routeKm > targetKm) {
          high = leg;
        } else {
          low = leg;
        }
        leg = (low + high) / 2;
      } catch (err) {
        console.error("Directions error", err);
        break;
      }
    }
  }

  if (!best) {
    return NextResponse.json(
      { error: "Could not generate a route" },
      { status: 500 }
    );
  }

  const feature: GeoJSON.Feature<GeoJSON.LineString> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: best.geometry.coordinates,
    },
  };

  const rawSteps: RouteStep[] =
    best.legs?.flatMap((leg) =>
      (leg.steps || []).map((s) => ({
        instruction: formatInstruction(s),
        distance_m: s.distance ?? 0,
        duration_s: s.duration ?? 0,
        // optional, useful later for highlighting on map:
        location: s.maneuver?.location ?? null, // [lng, lat]
        type: s.maneuver?.type ?? null,
        modifier: s.maneuver?.modifier ?? null,
        name: s.name ?? null,
      }))
    ) ?? [];
  const steps = simplifyRouteSteps(rawSteps);

  const distance_m = best.distance;
  const distance_km = distance_m / 1000;
  const duration_s = distance_km * RUN_PACE_MIN_PER_KM * 60;

  return NextResponse.json({
    geojson: feature,
    distance_m,
    duration_s,
    steps,
  });
}
