"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";

let hasInitializedPostHog = false;

export default function PostHogAnalytics() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!apiKey || hasInitializedPostHog) return;

    posthog.init(apiKey, {
      api_host:
        process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: true,
    });

    hasInitializedPostHog = true;
  }, []);

  useEffect(() => {
    if (!hasInitializedPostHog) return;

    const query = searchParams?.toString();
    const url = query ? `${pathname}?${query}` : pathname;

    posthog.capture("$pageview", {
      $current_url: url,
    });
  }, [pathname, searchParams]);

  return null;
}
