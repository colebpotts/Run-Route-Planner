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

type RouteQuality = {
  score: number;
  confidence: "strong" | "solid" | "mixed";
  distance_diff_km: number;
  overlap_penalty_km: number;
  smoothness_penalty_km: number;
  path_ratio: number;
  scenic_ratio: number;
  arterial_ratio: number;
  turn_count: number;
  highlight: string;
  warnings: string[];
};

type RouteVariant = {
  id: string;
  geojson: GeoJSON.Feature<GeoJSON.LineString>;
  distance_m: number;
  duration_s: number;
  steps: RouteStep[];
  quality: RouteQuality;
};

type RankedRoute = {
  route: MapboxRoute;
  score: number;
  routeKm: number;
  distanceDiffKm: number;
  weightedDistanceDiffKm: number;
  smoothnessPenaltyKm: number;
  overlapPenaltyKm: number;
  hasMicroSpur: boolean;
  pathRatio: number;
  scenicRatio: number;
  arterialRatio: number;
  turnCount: number;
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

function getRouteOverlapStats(route: MapboxRoute) {
  const coords = route.geometry?.coordinates ?? [];
  if (coords.length < 3) {
    return {
      penaltyKm: 0,
      microSpurMeters: 0,
      tailSpurMeters: 0,
    };
  }

  const seenSegments = new Set<string>();
  const recentSegments: Array<{
    key: string;
    meters: number;
    cumMetersBefore: number;
  }> = [];
  let totalMeters = 0;
  let overlapMeters = 0;
  let localBacktrackMeters = 0;
  let repeatedRunMeters = 0;
  let shortRepeatedRunMeters = 0;
  let microSpurMeters = 0;
  let tailSpurMeters = 0;
  let repeatedRunStartMeters = 0;

  const flushRepeatedRun = () => {
    // Allow long out-and-back returns, but penalize short overlap bursts
    // that usually come from pointless little reversals.
    if (repeatedRunMeters > 0 && repeatedRunMeters < 180) {
      shortRepeatedRunMeters += repeatedRunMeters;
    }
    // Extra penalty for short overlap bursts near the end of the route,
    // which tend to be "just add a few meters" tails.
    const repeatedRunProgress = totalMeters > 0 ? repeatedRunStartMeters / totalMeters : 0;
    if (repeatedRunMeters > 0 && repeatedRunMeters < 260 && repeatedRunProgress >= 0.65) {
      tailSpurMeters += repeatedRunMeters;
    }
    repeatedRunMeters = 0;
    repeatedRunStartMeters = 0;
  };

  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const segmentMeters = distanceMeters(prev, curr);
    if (segmentMeters < 5) continue;

    totalMeters += segmentMeters;
    const key = segmentKey(prev, curr);

    if (seenSegments.has(key)) {
      overlapMeters += segmentMeters;
      if (repeatedRunMeters === 0) {
        repeatedRunStartMeters = totalMeters - segmentMeters;
      }
      repeatedRunMeters += segmentMeters;

      // If a segment repeats very soon after it was first used, it's usually
      // a tiny out-and-back spur rather than a deliberate long return.
      const recentMatch = [...recentSegments].reverse().find((s) => s.key === key);
      if (recentMatch) {
        localBacktrackMeters += segmentMeters;

        const enclosedMeters = totalMeters - segmentMeters - recentMatch.cumMetersBefore;
        const isTinySpurSegment = segmentMeters <= 90;
        const isImmediateReversalArea = enclosedMeters <= 180;
        if (isTinySpurSegment && isImmediateReversalArea) {
          microSpurMeters += segmentMeters;
        }
      }
    } else {
      flushRepeatedRun();
      seenSegments.add(key);
    }

    recentSegments.push({
      key,
      meters: segmentMeters,
      cumMetersBefore: totalMeters - segmentMeters,
    });
    if (recentSegments.length > 14) {
      recentSegments.shift();
    }
  }

  flushRepeatedRun();

  if (totalMeters <= 0) {
    return {
      penaltyKm: 0,
      microSpurMeters,
      tailSpurMeters,
    };
  }

  const overlapRatio = overlapMeters / totalMeters;
  const localBacktrackKm = localBacktrackMeters / 1000;
  const shortRepeatedRunKm = shortRepeatedRunMeters / 1000;
  const microSpurKm = microSpurMeters / 1000;
  const tailSpurKm = tailSpurMeters / 1000;

  // General overlap remains a small penalty. Local short reversals get
  // extra weight because they feel much worse to run than a long return leg.
  const penaltyKm =
    overlapRatio * 0.9 +
    localBacktrackKm * 3.5 +
    shortRepeatedRunKm * 1.8 +
    microSpurKm * 6 +
    tailSpurKm * 9;

  return {
    penaltyKm,
    microSpurMeters,
    tailSpurMeters,
  };
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
  let ultraShortTurnCount = 0;
  let uTurnCount = 0;

  for (const step of steps) {
    const maneuverType = step?.maneuver?.type ?? "";
    const maneuverModifier = step?.maneuver?.modifier ?? "";
    const isTurnLike =
      maneuverType.includes("turn") ||
      maneuverType === "fork" ||
      maneuverType === "roundabout";

    if (!isTurnLike) continue;

    totalTurnCount += 1;
    if (maneuverModifier.includes("uturn")) {
      uTurnCount += 1;
    }
    const stepDistance = step?.distance ?? 0;
    if (stepDistance < 25) {
      ultraShortTurnCount += 1;
    }
    if (stepDistance < 45) {
      shortTurnCount += 1;
    }
  }

  const routeKm = Math.max(metersToKm(route.distance ?? 0), 0.1);
  const turnDensity = totalTurnCount / routeKm;

  // Convert maneuver complexity into a km-equivalent cost so distance can still dominate.
  // Short turns and turn-dense routes are penalized more heavily.
  return (
    uTurnCount * 0.45 +
    ultraShortTurnCount * 0.2 +
    shortTurnCount * 0.14 +
    totalTurnCount * 0.03 +
    Math.max(0, turnDensity - 2.4) * 0.12
  );
}

function getRouteRoadFeelStats(route: MapboxRoute) {
  const steps = route.legs?.flatMap((leg) => leg.steps || []) ?? [];
  let totalDistance = 0;
  let pathDistance = 0;
  let scenicDistance = 0;
  let arterialDistance = 0;
  let turnCount = 0;

  const scenicTerms = [
    "park",
    "greenway",
    "trail",
    "river",
    "lake",
    "beach",
    "waterfront",
    "promenade",
    "creek",
    "forest",
    "seawall",
  ];
  const arterialTerms = [
    "highway",
    "freeway",
    "expressway",
    "motorway",
    "ramp",
    "state route",
    "county road",
  ];

  for (const step of steps) {
    const stepDistance = Math.max(step.distance ?? 0, 0);
    const name = step.name?.trim().toLowerCase() ?? "";
    totalDistance += stepDistance;

    const isTurnLike =
      step.maneuver?.type === "turn" ||
      step.maneuver?.type === "fork" ||
      step.maneuver?.type === "merge" ||
      step.maneuver?.type === "roundabout";

    if (isTurnLike) {
      turnCount += 1;
    }

    if (!name) continue;

    if (isGenericPathName(name)) {
      pathDistance += stepDistance;
    }

    if (scenicTerms.some((term) => name.includes(term))) {
      scenicDistance += stepDistance;
    }

    if (arterialTerms.some((term) => name.includes(term))) {
      arterialDistance += stepDistance;
    }
  }

  if (totalDistance <= 0) {
    return {
      pathRatio: 0,
      scenicRatio: 0,
      arterialRatio: 0,
      turnCount,
    };
  }

  return {
    pathRatio: pathDistance / totalDistance,
    scenicRatio: scenicDistance / totalDistance,
    arterialRatio: arterialDistance / totalDistance,
    turnCount,
  };
}

function getAsymmetricDistancePenaltyKm(routeKm: number, targetKm: number) {
  const diffKm = routeKm - targetKm;

  if (diffKm >= 0) {
    // Slightly long is preferable to slightly short.
    return diffKm * 0.35;
  }

  // Penalize undershooting more than overshooting.
  return Math.abs(diffKm) * 0.95;
}

function scoreRoute(route: MapboxRoute, targetKm: number) {
  const routeKm = metersToKm(route.distance ?? 0);
  const distanceDiffKm = Math.abs(routeKm - targetKm);
  const smoothnessPenaltyKm = getRouteSmoothnessPenaltyKm(route);
  const overlapStats = getRouteOverlapStats(route);
  const overlapPenaltyKm = overlapStats.penaltyKm;
  const weightedDistanceDiffKm = getAsymmetricDistancePenaltyKm(routeKm, targetKm);
  const hasMicroSpur =
    overlapStats.microSpurMeters >= 20 || overlapStats.tailSpurMeters >= 35;
  const roadFeel = getRouteRoadFeelStats(route);
  const sceneryBonusKm = roadFeel.pathRatio * 0.4 + roadFeel.scenicRatio * 0.55;
  const arterialPenaltyKm = roadFeel.arterialRatio * 0.75;

  return {
    routeKm,
    distanceDiffKm,
    weightedDistanceDiffKm,
    smoothnessPenaltyKm,
    overlapPenaltyKm,
    hasMicroSpur,
    pathRatio: roadFeel.pathRatio,
    scenicRatio: roadFeel.scenicRatio,
    arterialRatio: roadFeel.arterialRatio,
    turnCount: roadFeel.turnCount,
    score:
      weightedDistanceDiffKm +
      smoothnessPenaltyKm +
      overlapPenaltyKm +
      arterialPenaltyKm -
      sceneryBonusKm,
  };
}

function buildRouteSignature(route: MapboxRoute) {
  const coords = route.geometry.coordinates;
  if (coords.length === 0) return "empty";
  const sampleEvery = Math.max(1, Math.floor(coords.length / 10));
  return coords
    .filter((_, index) => index % sampleEvery === 0)
    .map(([lng, lat]) => `${lng.toFixed(3)},${lat.toFixed(3)}`)
    .join("|");
}

function getConfidence(metrics: RankedRoute): RouteQuality["confidence"] {
  if (
    metrics.distanceDiffKm <= 0.25 &&
    metrics.overlapPenaltyKm <= 0.2 &&
    metrics.smoothnessPenaltyKm <= 0.65 &&
    metrics.arterialRatio <= 0.08
  ) {
    return "strong";
  }

  if (
    metrics.distanceDiffKm <= 0.55 &&
    metrics.overlapPenaltyKm <= 0.45 &&
    metrics.smoothnessPenaltyKm <= 1.1 &&
    metrics.arterialRatio <= 0.18
  ) {
    return "solid";
  }

  return "mixed";
}

function getRouteHighlight(metrics: RankedRoute) {
  if (metrics.pathRatio >= 0.35 || metrics.scenicRatio >= 0.22) {
    return "More path-heavy and scenic than the typical option.";
  }

  if (metrics.overlapPenaltyKm <= 0.18 && metrics.smoothnessPenaltyKm <= 0.6) {
    return "Clean loop with low backtracking and smoother turns.";
  }

  if (metrics.distanceDiffKm <= 0.2) {
    return "Very close to your requested distance.";
  }

  return "Balanced option with acceptable route shape.";
}

function getRouteWarnings(metrics: RankedRoute) {
  const warnings: string[] = [];

  if (metrics.overlapPenaltyKm >= 0.4) {
    warnings.push("Includes some repeated segments.");
  }

  if (metrics.smoothnessPenaltyKm >= 1.1) {
    warnings.push("Has more tight turns than ideal.");
  }

  if (metrics.arterialRatio >= 0.12) {
    warnings.push("May spend more time on larger roads.");
  }

  if (metrics.distanceDiffKm >= 0.6) {
    warnings.push("Distance drifts from the target more than usual.");
  }

  return warnings;
}

function toRouteVariant(id: string, rankedRoute: RankedRoute): RouteVariant {
  const feature: GeoJSON.Feature<GeoJSON.LineString> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: rankedRoute.route.geometry.coordinates,
    },
  };

  const rawSteps: RouteStep[] =
    rankedRoute.route.legs?.flatMap((leg) =>
      (leg.steps || []).map((s) => ({
        instruction: formatInstruction(s),
        distance_m: s.distance ?? 0,
        duration_s: s.duration ?? 0,
        location: s.maneuver?.location ?? null,
        type: s.maneuver?.type ?? null,
        modifier: s.maneuver?.modifier ?? null,
        name: s.name ?? null,
      }))
    ) ?? [];

  const steps = simplifyRouteSteps(rawSteps);
  const distance_m = rankedRoute.route.distance;
  const distance_km = distance_m / 1000;

  return {
    id,
    geojson: feature,
    distance_m,
    duration_s: distance_km * RUN_PACE_MIN_PER_KM * 60,
    steps,
    quality: {
      score: Number(rankedRoute.score.toFixed(3)),
      confidence: getConfidence(rankedRoute),
      distance_diff_km: Number(rankedRoute.distanceDiffKm.toFixed(2)),
      overlap_penalty_km: Number(rankedRoute.overlapPenaltyKm.toFixed(2)),
      smoothness_penalty_km: Number(rankedRoute.smoothnessPenaltyKm.toFixed(2)),
      path_ratio: Number(rankedRoute.pathRatio.toFixed(3)),
      scenic_ratio: Number(rankedRoute.scenicRatio.toFixed(3)),
      arterial_ratio: Number(rankedRoute.arterialRatio.toFixed(3)),
      turn_count: rankedRoute.turnCount,
      highlight: getRouteHighlight(rankedRoute),
      warnings: getRouteWarnings(rankedRoute),
    },
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
  const bearingTries = 22;
  const tuneSteps = 7;
  const toleranceKm = Math.min(1.2, Math.max(0.6, targetKm * 0.15));

  const candidateRoutes = new Map<string, RankedRoute>();

  for (let t = 0; t < bearingTries; t++) {
    const b1 = Math.random() * 360;
    const b2 = (b1 + 95 + Math.random() * 90) % 360;
    const useThreeWaypoints =
      targetKm >= 8 ? Math.random() < 0.55 : Math.random() < 0.3;
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

        const metrics = scoreRoute(
          route,
          targetKm
        );
        const { routeKm, score, hasMicroSpur } = metrics;

        const isTooShort = routeKm < targetKm - toleranceKm;
        const selectionScore =
          score +
          (hasMicroSpur ? 2.25 : 0) +
          (isTooShort ? 1.5 : 0) +
          (routeKm > targetKm + toleranceKm * 1.6 ? 0.45 : 0);
        const signature = buildRouteSignature(route);
        const existing = candidateRoutes.get(signature);

        if (!existing || selectionScore < existing.score) {
          candidateRoutes.set(signature, {
            ...metrics,
            route,
            score: selectionScore,
          });
        }

        if (!hasMicroSpur && routeKm >= targetKm && metrics.distanceDiffKm <= toleranceKm) break;

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

  const rankedRoutes = [...candidateRoutes.values()]
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);

  if (rankedRoutes.length === 0) {
    return NextResponse.json(
      { error: "Could not generate a route" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    route: toRouteVariant("route-1", rankedRoutes[0]),
  });
}
