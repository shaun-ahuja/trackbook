// Pure proxy — no business logic. Forwards the scenario matrix JSON to the
// Julia optimizer on port 2024 and relays the response unchanged.
export const dynamic = "force-dynamic";

const JULIA_URL = "http://127.0.0.1:2024/optimize";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.text();
    const upstream = await fetch(JULIA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: "optimizer unavailable", detail: msg }, { status: 503 });
  }
}
