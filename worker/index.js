const MAX = 500, SIZE = 1000, COLORS = 16;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function ipHash(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pc-salt:" + ip));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/pixels" && request.method === "GET") {
      const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
      const { results } = await env.DB.prepare(
        "SELECT id, x, y, c FROM pixels WHERE id > ? ORDER BY id LIMIT 50000").bind(since).all();
      const flat = [];
      for (const r of results) flat.push(r.id, r.x, r.y, r.c);
      return json({ p: flat, more: results.length === 50000 });
    }

    if (url.pathname === "/me" && request.method === "GET") {
      const ip = await ipHash(request);
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM pixels WHERE ip = ?").bind(ip).first();
      return json({ used: r.n, max: MAX });
    }

    if (url.pathname === "/place" && request.method === "POST") {
      let b; try { b = await request.json(); } catch { return json({ error: "bad request" }, 400); }
      const { x, y, c } = b || {};
      if (![x, y, c].every(Number.isInteger) || x < 0 || y < 0 || x >= SIZE || y >= SIZE || c < 0 || c >= COLORS)
        return json({ error: "bad request" }, 400);
      const ip = await ipHash(request);
      // single atomic statement: insert only if under the limit and cell is free
      const res = await env.DB.prepare(
        "INSERT OR IGNORE INTO pixels (x, y, c, ip) SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM pixels WHERE ip = ?4) < ?5"
      ).bind(x, y, c, ip, MAX).run();
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM pixels WHERE ip = ?").bind(ip).first();
      if (res.meta.changes === 1) return json({ ok: true, used: r.n });
      if (r.n >= MAX) return json({ error: `You've used all ${MAX} pixels.`, used: r.n }, 429);
      return json({ error: "That pixel is already taken.", used: r.n }, 409);
    }

    return json({ error: "not found" }, 404);
  },
};
