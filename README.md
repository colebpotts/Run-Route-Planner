# RunRoutr

Generate great running routes near you.

RunRoutr is a lightweight web app that creates looped running routes based on your location and desired distance. It uses real street and trail data to generate routes that actually work in the real world.

---

## Features

- 📍 Uses your current location as the start point
- 🔁 Generates looped running routes
- 📏 Choose your target distance (in km)
- 🗺️ Automatically fits the map view to the generated route
- 🕒 Shows estimated distance and duration
- ⚡ Fast, simple, no account required

---

## How it works

- **Frontend:** Next.js + TypeScript + Mapbox GL
- **Routing:** Mapbox Directions API (walking profile)
- **Logic:** Server-side route generation with waypoint tuning to match target distance
- **UX:** Minimal, utility-first design focused on runners

The app attempts multiple loop shapes and tunes waypoint distances until the generated route closely matches the requested distance.

---

## Getting started (local development)

### Prerequisites

- Node.js (v18+ recommended)
- A Mapbox account

