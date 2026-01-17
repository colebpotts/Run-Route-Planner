import { NextResponse } from "next/server";

function metersToKm(m: number) {
  return m / 1000;
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
) {
  const coordStr = coords.map((c) => `${c.lng},${c.lat}`).join(";");
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordStr}` +
    `?geometries=geojson&overview=full&steps=false&access_token=${token}`;

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

  // Try a few bearings, and for each one, tune the waypoint radius to match targetKm
  const bearingTries = 4;          // number of different loop shapes to try
  const tuneSteps = 6;             // iterations per shape (keeps it fast)
  const toleranceKm = 0.35;        // how close is "good enough"

  let best: any = null;
  let bestDiff = Infinity;

  for (let t = 0; t < bearingTries; t++) {
    const b1 = Math.random() * 360;
    const b2 = (b1 + 110 + Math.random() * 80) % 360;

    // Start with a smaller guess than before (roads add distance)
    // These bounds keep it stable for short/long runs.
    let low = targetKm * 0.12;
    let high = targetKm * 0.45;
    let leg = targetKm * 0.22;

    for (let s = 0; s < tuneSteps; s++) {
      const wp1 = destinationPoint(start.lat, start.lng, b1, leg);
      const wp2 = destinationPoint(start.lat, start.lng, b2, leg);
      const coords = [start, wp1, wp2, start];

      try {
        const data = await fetchDirections(coords, token);
        const route = data?.routes?.[0];
        if (!route) continue;

        const routeKm = metersToKm(route.distance);
        const diff = Math.abs(routeKm - targetKm);

        if (diff < bestDiff) {
          bestDiff = diff;
          best = route;
        }

        if (diff <= toleranceKm) break;

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

  return NextResponse.json({
    geojson: feature,
    distance_m: best.distance,
    duration_s: best.duration,
  });
}
