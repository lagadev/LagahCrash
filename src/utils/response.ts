export function ok(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify({ ok: true, ...((data as object) ?? {}) }), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export function fail(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
