// Pure proxy — no business logic. Forwards the scenario matrix JSON to the
// Julia optimizer on port 2024 and relays the response unchanged.
export const dynamic = "force-dynamic";

const JULIA_URL = process.env.OPTIMIZER_URL
  ? `${process.env.OPTIMIZER_URL}/optimize`
  : "http://127.0.0.1:2024/optimize";

export async function POST(request: Request): Promise<Response> {
  const t0 = Date.now();
  let bodySize = 0;
  try {
    const body = await request.text();
    bodySize = body.length;
    console.log(`[proxy] request received bytes=${bodySize} forwarding=${JULIA_URL}`);
    const upstream = await fetch(JULIA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await upstream.text();
    const elapsed = Date.now() - t0;
    console.log(`[proxy] upstream status=${upstream.status} elapsed=${elapsed}ms bodyPreview=${data.slice(0, 200)}`);
    return new Response(data, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const elapsed = Date.now() - t0;
    const name = err instanceof Error ? err.constructor.name : "UnknownError";
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[proxy] fetch failed elapsed=${elapsed}ms errorType=${name} bytes=${bodySize} detail=${msg}`);
    return Response.json({ error: "optimizer unavailable", detail: msg }, { status: 503 });
  }
}
