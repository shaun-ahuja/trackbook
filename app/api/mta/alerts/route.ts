import { fetchMtaAlerts } from "@/lib/mta/fetchMtaAlerts";
import { parseMtaAlerts } from "@/lib/mta/parseMtaAlerts";
import type { AlertsResponse } from "@/lib/mta/types";

// Route handlers in Next 16 are not cached by default, but the inner
// fetch() can still be cached — force-dynamic plus cache: "no-store" on
// the upstream fetch guarantees fresh data every poll.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const raw = await fetchMtaAlerts();
    const alerts = parseMtaAlerts(raw);
    const body: AlertsResponse = { alerts, fetchedAt: Date.now() };
    return Response.json(body);
  } catch (err) {
    const body: AlertsResponse = {
      alerts: [],
      fetchedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
    // 200 so the client treats it as "no alerts" and hybrid mode can
    // fall back to synthetic. Errors stay in the payload for diagnostics.
    return Response.json(body);
  }
}
