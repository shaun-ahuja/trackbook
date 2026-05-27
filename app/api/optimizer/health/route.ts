export const dynamic = "force-dynamic";

const JULIA_HEALTH_URL = "http://127.0.0.1:2024/health";

export async function GET(): Promise<Response> {
  const t0 = Date.now();
  try {
    const res = await fetch(JULIA_HEALTH_URL, { signal: AbortSignal.timeout(3_000) });
    const body = await res.json();
    return Response.json({ proxy: "ok", julia: body, elapsed: Date.now() - t0 });
  } catch (err) {
    const name = err instanceof Error ? err.constructor.name : "UnknownError";
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { proxy: "ok", julia: null, error: name, detail: msg, elapsed: Date.now() - t0 },
      { status: 503 },
    );
  }
}
