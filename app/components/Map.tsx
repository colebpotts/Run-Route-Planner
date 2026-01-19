"use client";

import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState, useMemo } from "react";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

type LngLat = { lng: number; lat: number };

const FALLBACK_CENTER: LngLat = {
  lng: -123.1207, // Vancouver
  lat: 49.2827,
};

type RouteResponse = {
  geojson: GeoJSON.Feature<GeoJSON.LineString>;
  distance_m: number;
  duration_s: number;
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

  // Create the map + base marker + empty route layer once
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
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

      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: {
          "line-width": 5,
        },
      });
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

  // Update route source when route changes AND fit map to route
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const source = map.getSource("route") as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    if (!route) {
      source.setData({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [] },
        properties: {},
      } as GeoJSON.Feature<GeoJSON.LineString>);
      return;
    }

    // Update line geometry
    source.setData(route.geojson);

    // Fit bounds to route
    const coords = route.geojson.geometry.coordinates as [number, number][];
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
    return `${kmVal.toFixed(2)} km • ${Math.round(minVal)} min`;
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
    } catch (err: any) {
      console.error(err);
      setRouteError(err.message || "Could not generate route");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {routeError && <p className="text-sm text-red-600">{routeError}</p>}

      <div className="flex flex-wrap gap-3 items-center">
        <label className="text-sm">
          Distance (km):
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
            className="ml-2 px-2 py-1 rounded border text-sm w-24"
            placeholder="e.g. 5"
          />
        </label>

        <button
          onClick={generateRoute}
          disabled={loading || !isKmValid}
          className="px-3 py-1 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
        >
          {loading ? "Generating..." : "Generate route"}
        </button>
      </div>

      <div className="text-xs text-gray-600 space-y-1">
        <div>
          Start: lng {center.lng.toFixed(5)}, lat {center.lat.toFixed(5)}
        </div>
        <div>
          Target: {isKmValid ? `${km.toFixed(1)} km` : "invalid distance"}
          {distanceLabel && <> • Route: {distanceLabel}</>}
        </div>
      </div>

      <div ref={mapContainerRef} className="h-[70vh] w-full rounded-xl" />
    </div>
  );
}
