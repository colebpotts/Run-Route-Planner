"use client";

import Map from "./components/Map";

export default function Home() {
  return (
    <main className="min-h-screen p-4 max-w-3xl mx-auto space-y-4">
      <h1 className="text-2xl font-semibold">RunRoutr</h1>
      <Map />
    </main>
  );
}
