const MAX = 500, SIZE = 1000;
const LEGACY = [0xffffff,0xe4e4e4,0x888888,0x222222,0xffa7d1,0xe50000,0xe59500,0xa06a42,0xe5d900,0x94e044,0x02be01,0x00d3dd,0x0083c7,0x0000ea,0xcf6ee4,0x820080]; // old clients sent palette indexes 0-15
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
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM pixels WHERE c >= 0 AND ip = ?").bind(ip).first();
      return json({ used: r.n, max: MAX });
    }

    if (url.pathname === "/place" && request.method === "POST") {
      let b; try { b = await request.json(); } catch { return json({ error: "bad request" }, 400); }
      let { x, y, c } = b || {};
      if (![x, y, c].every(Number.isInteger) || x < 0 || y < 0 || x >= SIZE || y >= SIZE || c < 0 || c > 0xFFFFFF)
        return json({ error: "bad request" }, 400);
      if (b.v !== 2) { if (c >= LEGACY.length) return json({ error: "bad request" }, 400); c = LEGACY[c]; }
      const ip = await ipHash(request);
      // single atomic statement: insert only if under the limit and cell is free
      const [, res] = await env.DB.batch([
        env.DB.prepare("DELETE FROM pixels WHERE x = ? AND y = ? AND c < 0").bind(x, y),   // erased cells hold a marker row; free it
        env.DB.prepare(
          "INSERT OR IGNORE INTO pixels (x, y, c, ip) SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM pixels WHERE c >= 0 AND ip = ?4) < ?5"
        ).bind(x, y, c, ip, MAX),
      ]);
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM pixels WHERE c >= 0 AND ip = ?").bind(ip).first();
      if (res.meta.changes === 1) return json({ ok: true, used: r.n });
      if (r.n >= MAX) return json({ error: `You've used all ${MAX} pixels.`, used: r.n }, 429);
      return json({ error: "That pixel is already taken.", used: r.n }, 409);
    }

    // which pixels are mine (so the client knows what it may erase)
    if (url.pathname === "/mine" && request.method === "GET") {
      const ip = await ipHash(request);
      const { results } = await env.DB.prepare("SELECT x, y FROM pixels WHERE c >= 0 AND ip = ?").bind(ip).all();
      const flat = []; for (const r of results) flat.push(r.x, r.y);
      return json({ m: flat });
    }

    // erase: only ever deletes a pixel whose owner (ip) matches the requester
    if (url.pathname === "/erase" && request.method === "POST") {
      let b; try { b = await request.json(); } catch { return json({ error: "bad request" }, 400); }
      const { x, y } = b || {};
      if (![x, y].every(Number.isInteger) || x < 0 || y < 0 || x >= SIZE || y >= SIZE) return json({ error: "bad request" }, 400);
      const ip = await ipHash(request);
      const [del] = await env.DB.batch([
        env.DB.prepare("DELETE FROM pixels WHERE x = ?1 AND y = ?2 AND c >= 0 AND ip = ?3").bind(x, y, ip),
        // leave a marker (c = -1, new id) so other people's pages learn the pixel is gone
        env.DB.prepare("INSERT INTO pixels (x, y, c, ip) SELECT ?1, ?2, -1, '' WHERE changes() = 1").bind(x, y),
      ]);
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM pixels WHERE c >= 0 AND ip = ?").bind(ip).first();
      if (del.meta.changes === 1) return json({ ok: true, used: r.n });
      return json({ error: "You can only erase your own pixels.", used: r.n }, 403);
    }

    return json({ error: "not found" }, 404);
  },
};
