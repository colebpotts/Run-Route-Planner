"use client";

import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState, useMemo } from "react";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

type LngLat = { lng: number; lat: number };

const FALLBACK_CENTER: LngLat = {
  lng: -123.1207, // Vancouver
  lat: 49.2827,
};

type RouteStep = {
  instruction: string;
  distance_m: number;
  duration_s: number;
  location: [number, number] | null; // [lng, lat]
  type: string | null;
  modifier: string | null;
};

type RouteResponse = {
  geojson: GeoJSON.Feature<GeoJSON.LineString>;
  distance_m: number;
  duration_s: number;
  steps: RouteStep[];
};

export default function Map() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  const [center, setCenter] = useState<LngLat>(FALLBACK_CENTER);
  const [error, setError] = useState<string | null>(null);

  // distance state
  const [km, setKm] = useState<number>(5);
  const [kmInput, setKmInput] = useState<string>("5");

  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  const [showDirections, setShowDirections] = useState(false);
  const [showMobileRouteForm, setShowMobileRouteForm] = useState(false);

  // Create the map + base marker + empty route layer once
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/outdoors-v12",
      center: [center.lng, center.lat],
      zoom: 13,
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    const marker = new mapboxgl.Marker()
      .setLngLat([center.lng, center.lat])
      .addTo(map);

    map.on("load", () => {
      // Route source with empty line at first
      map.addSource("route", {
  type: "geojson",
  data: {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [] },
    properties: {},
  } as GeoJSON.Feature<GeoJSON.LineString>,
});

// Find the first label layer so we can draw the route *under* street names
const layers = map.getStyle().layers;
let labelLayerId: string | undefined;

if (layers) {
  for (const layer of layers) {
    const symbolLayer = layer as mapboxgl.SymbolLayer;
    if (
      layer.type === "symbol" &&
      symbolLayer.layout?.["text-field"]
    ) {
      labelLayerId = layer.id;
      break;
    }
  }
}

// Subtle white casing under the route to make it pop on any background
map.addLayer(
  {
    id: "route-casing",
    type: "line",
    source: "route",
    paint: {
      "line-color": "rgba(255,255,255,0.9)",
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        5,
        13,
        7,
        16,
        9,
      ],
      "line-opacity": 0.85,
    },
  },
  labelLayerId // insert just under labels if we found one
);

// Main route line: lighter blue, slightly thinner, on top of casing
map.addLayer(
  {
    id: "route-line",
    type: "line",
    source: "route",
    paint: {
      "line-color": "#0ea5e9", // sky-500
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        3,
        13,
        5,
        16,
        7,
      ],
      "line-opacity": 0.9,
    },
  },
  labelLayerId
);


      // Add arrow markers source
      map.addSource("route-arrows", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });

      // Create arrow icon (arrowhead only, no tail - pointing north/up by default)
      const arrowSvg = `
        <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M 6 10 L 12 6 L 18 10 Z" 
                stroke="#3b82f6" 
                stroke-width="2.5" 
                stroke-linecap="round"
                stroke-linejoin="round" 
                fill="#3b82f6"/>
        </svg>
      `.trim();

      const img = new Image();
      img.onload = () => {
        if (!map.hasImage("arrow-icon")) {
          map.addImage("arrow-icon", img);
        }
        // Add arrow layer after image is loaded
        if (!map.getLayer("route-arrows")) {
          map.addLayer({
            id: "route-arrows",
            type: "symbol",
            source: "route-arrows",
            layout: {
              "icon-image": "arrow-icon",
              "icon-size": 1.0,
              "icon-rotate": ["get", "bearing"],
              "icon-rotation-alignment": "map",
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });
        }
      };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(arrowSvg);
    });

    mapRef.current = map;
    markerRef.current = marker;

    return () => {
      marker.remove();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // Ask for your real location and recenter
  useEffect(() => {
    if (!navigator.geolocation) {
      setError("Geolocation not supported, showing fallback location.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const newCenter = {
          lng: pos.coords.longitude,
          lat: pos.coords.latitude,
        };

        setCenter(newCenter);

        const map = mapRef.current;
        const marker = markerRef.current;
        if (map) {
          map.setCenter([newCenter.lng, newCenter.lat]);
        }
        if (marker) {
          marker.setLngLat([newCenter.lng, newCenter.lat]);
        }
      },
      () => {
        setError("Could not get your location, showing fallback location.");
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, []);

  // Helper function to calculate bearing between two points
  function calculateBearing(
    point1: [number, number],
    point2: [number, number]
  ): number {
    const lat1 = (point1[1] * Math.PI) / 180;
    const lat2 = (point2[1] * Math.PI) / 180;
    const dLng = ((point2[0] - point1[0]) * Math.PI) / 180;

    const y = Math.sin(dLng) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

    const bearing = Math.atan2(y, x);
    return ((bearing * 180) / Math.PI + 360) % 360;
  }

  function angleDifference(angle1: number, angle2: number): number {
    let diff = Math.abs(angle1 - angle2);
    if (diff > 180) diff = 360 - diff;
    return diff;
  }

  function isStraightStretch(
    coordinates: [number, number][],
    index: number,
    windowSize: number = 5,
    maxAngleChange: number = 15
  ): boolean {
    if (index < windowSize || index >= coordinates.length - windowSize) {
      return false;
    }

    const prevStart = coordinates[index - windowSize];
    const prevEnd = coordinates[index];
    const nextStart = coordinates[index];
    const nextEnd = coordinates[index + windowSize];

    const prevBearing = calculateBearing(prevStart, prevEnd);
    const nextBearing = calculateBearing(nextStart, nextEnd);

    const angleDiff = angleDifference(prevBearing, nextBearing);
    return angleDiff <= maxAngleChange;
  }

  function generateArrowMarkers(
    coordinates: [number, number][]
  ): GeoJSON.FeatureCollection {
    if (coordinates.length < 10) {
      return { type: "FeatureCollection", features: [] };
    }

    const features: GeoJSON.Feature[] = [];
    const sampleSpacing = Math.max(3, Math.floor(coordinates.length / 20));
    const minSpacing = Math.max(10, Math.floor(coordinates.length / 8));

    let lastArrowIndex = -minSpacing;

    for (
      let i = sampleSpacing * 2;
      i < coordinates.length - sampleSpacing * 2;
      i += sampleSpacing
    ) {
      if (i - lastArrowIndex < minSpacing) continue;
      if (!isStraightStretch(coordinates, i)) continue;

      const current = coordinates[i];
      const lookAhead = Math.min(5, Math.floor((coordinates.length - i) / 2));
      const next = coordinates[Math.min(i + lookAhead, coordinates.length - 1)];

      const bearing = calculateBearing(current, next);

      features.push({
        type: "Feature",
        properties: { bearing },
        geometry: {
          type: "Point",
          coordinates: current,
        },
      });

      lastArrowIndex = i;
    }

    return {
      type: "FeatureCollection",
      features,
    };
  }

  // Update route source when route changes AND fit map to route
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const source = map.getSource("route") as mapboxgl.GeoJSONSource | undefined;
    const arrowSource = map.getSource(
      "route-arrows"
    ) as mapboxgl.GeoJSONSource | undefined;

    if (!source) return;

    if (!route) {
      source.setData({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [] },
        properties: {},
      } as GeoJSON.Feature<GeoJSON.LineString>);
      if (arrowSource) {
        arrowSource.setData({
          type: "FeatureCollection",
          features: [],
        });
      }
      return;
    }

    source.setData(route.geojson);

    const coords = route.geojson.geometry.coordinates as [number, number][];
    if (coords && coords.length > 0 && arrowSource) {
      const arrowMarkers = generateArrowMarkers(coords);
      arrowSource.setData(arrowMarkers);

      if (map.hasImage("arrow-icon") && !map.getLayer("route-arrows")) {
        map.addLayer({
          id: "route-arrows",
          type: "symbol",
          source: "route-arrows",
          layout: {
            "icon-image": "arrow-icon",
            "icon-size": 1.0,
            "icon-rotate": ["get", "bearing"],
            "icon-rotation-alignment": "map",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        });
      }
    }

    if (!coords || coords.length === 0) return;

    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new mapboxgl.LngLatBounds(coords[0], coords[0])
    );

    map.fitBounds(bounds, {
      padding: 60,
      maxZoom: 15,
      duration: 800,
    });
  }, [route]);

  const distanceLabel = useMemo(() => {
    if (!route) return null;

    const kmVal = route.distance_m / 1000;
    const minVal = route.duration_s / 60;
    const paceMinPerKm = minVal / kmVal;

    const paceMin = Math.floor(paceMinPerKm);
    const paceSec = Math.round((paceMinPerKm - paceMin) * 60);

    return `${kmVal.toFixed(2)} km • ~${Math.round(
      minVal
    )} min @ ${paceMin}:${paceSec.toString().padStart(2, "0")} / km`;
  }, [route]);

  const isKmValid = useMemo(
    () => Number.isFinite(km) && km > 0.2 && km < 100,
    [km]
  );

  async function generateRoute() {
    if (!center) return;

    if (!isKmValid) {
      setRouteError("Please enter a valid distance in km (e.g. 3, 5.5).");
      return;
    }

    setLoading(true);
    setRouteError(null);

    try {
      const res = await fetch(
        `/api/route?lat=${center.lat}&lng=${center.lng}&km=${km}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to generate route");

      setRoute(data);
      setShowMobileRouteForm(false);
    } catch (err: unknown) {
      console.error(err);
      setRouteError(
        err instanceof Error ? err.message : "Could not generate route"
      );
    } finally {
      setLoading(false);
    }
  }

  const targetLabel = isKmValid ? `${km.toFixed(1)} km` : "invalid distance";

  return (
    <div className="relative h-screen w-full overflow-hidden text-slate-900">
      <div ref={mapContainerRef} className="h-full w-full" />

      <div className="pointer-events-none absolute inset-x-0 top-0 p-3 sm:p-5">
        <div className="glass-panel pointer-events-auto mx-auto w-full max-w-4xl rounded-3xl p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-sky-700">
                Route Planner
              </p>
              <h1 className="mt-1 text-2xl font-semibold text-slate-900 sm:text-3xl">
                RunRoutr
              </h1>
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-slate-200 bg-white/85 px-3 py-1 text-slate-600">
                Target {targetLabel}
              </span>
              {distanceLabel && (
                <span className="rounded-full border border-emerald-200 bg-emerald-50/85 px-3 py-1 text-emerald-700">
                  {distanceLabel}
                </span>
              )}
            </div>
          </div>

          {(error || routeError) && (
            <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {routeError || error}
            </div>
          )}

          <div className="mt-4 hidden gap-3 sm:grid sm:grid-cols-[minmax(170px,220px)_1fr]">
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
                Distance (km)
              </span>
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={kmInput}
                onChange={(e) => {
                  const value = e.target.value;
                  setKmInput(value);
                  const num = parseFloat(value);
                  if (Number.isFinite(num)) {
                    setKm(num);
                  }
                }}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-base text-slate-900 shadow-sm outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-200"
                placeholder="e.g. 5"
              />
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
              <button
                onClick={generateRoute}
                disabled={loading || !isKmValid}
                className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Generating..." : "Generate route"}
              </button>

              <button
                onClick={() => setShowDirections(true)}
                disabled={!route}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Directions
              </button>
            </div>
          </div>

          <div className="mt-3 text-xs text-slate-500">
            Start: {center.lat.toFixed(5)}, {center.lng.toFixed(5)}
          </div>
        </div>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 px-4 sm:hidden">
        <div className="mx-auto flex w-full max-w-sm flex-col gap-2">
          {showMobileRouteForm && (
            <div className="glass-panel pointer-events-auto space-y-3 rounded-2xl p-3">
              <label className="space-y-1">
                <span className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
                  Distance (km)
                </span>
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={kmInput}
                  onChange={(e) => {
                    const value = e.target.value;
                    setKmInput(value);
                    const num = parseFloat(value);
                    if (Number.isFinite(num)) {
                      setKm(num);
                    }
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-base text-slate-900 shadow-sm outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-200"
                  placeholder="e.g. 5"
                />
              </label>

              <div className="flex gap-2">
                <button
                  onClick={() => setShowMobileRouteForm(false)}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={generateRoute}
                  disabled={loading || !isKmValid}
                  className="flex-1 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? "Generating..." : "Generate route"}
                </button>
              </div>
            </div>
          )}

          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/95 p-1.5 shadow-lg backdrop-blur">
            <button
              onClick={() => setShowMobileRouteForm((prev) => !prev)}
              disabled={loading}
              className="flex-1 rounded-full bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {route ? "Edit Route" : "New Route"}
            </button>
            {route && (
              <button
                onClick={() => setShowDirections(true)}
                className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Directions
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Directions Modal */}
      {route && showDirections && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4">
          <div className="glass-panel flex max-h-[80vh] w-full max-w-lg flex-col rounded-3xl">
            <div className="flex items-center justify-between border-b border-slate-200/70 px-5 py-4">
              <h2 className="text-sm font-semibold text-slate-900">
                Directions ({route.steps?.length ?? 0} steps)
              </h2>
              <button
                onClick={() => setShowDirections(false)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Close
              </button>
            </div>

            <div className="border-b border-slate-200/70 px-5 py-3 text-xs text-slate-600">
              Target: {km.toFixed(1)} km
              {distanceLabel && <> • Route: {distanceLabel}</>}
            </div>

            <div className="overflow-y-auto px-5 py-4 text-sm">
              <ol className="space-y-2">
                {route.steps?.map((s, idx) => {
                  const meters = Math.round(s.distance_m);
                  const mins = Math.max(1, Math.round(s.duration_s / 60));
                  return (
                    <li
                      key={idx}
                      className="rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2"
                    >
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                        Step {idx + 1}
                      </div>
                      <div className="mt-1 font-medium text-slate-900">
                        {s.instruction || "Continue"}
                      </div>
                      <div className="mt-1 text-xs text-slate-600">
                        {meters} m • ~{mins} min
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
