// Server-side fetch of one NYCT GTFS-RT trip-updates feed. Returns the
// raw protobuf payload; decoding happens in parseTripUpdates so this
// file stays trivially testable / mockable.

export async function fetchTripFeed(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; TrackBook/0.1)",
      accept: "application/x-protobuf,application/octet-stream",
    },
  });
  if (!res.ok) {
    throw new Error(`Trip feed ${url} responded ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}
