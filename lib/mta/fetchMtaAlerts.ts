// Server-side fetch of the MTA Service Status feed. This is the same
// JSON source that powers the mta.info service-status box — no API key,
// permissive CORS, and aggregates alerts across subway/bus/rail in one
// payload. We filter to subway-mode routes downstream in parseMtaAlerts.

const MTA_SERVICE_STATUS_URL =
  "https://collector-otp-prod.camsys-apps.com/realtime/serviceStatus";

export async function fetchMtaAlerts(): Promise<unknown> {
  const res = await fetch(MTA_SERVICE_STATUS_URL, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      // Some upstream CDNs reject empty UAs; pretend to be a browser.
      "user-agent": "Mozilla/5.0 (compatible; TransitAlpha/0.1)",
    },
  });
  if (!res.ok) {
    throw new Error(`MTA service-status feed responded ${res.status}`);
  }
  return res.json();
}
