const MAX = 1000, SIZE = 1000;
const LEGACY = [0xffffff,0xe4e4e4,0x888888,0x222222,0xffa7d1,0xe50000,0xe59500,0xa06a42,0xe5d900,0x94e044,0x02be01,0x00d3dd,0x0083c7,0x0000ea,0xcf6ee4,0x820080]; // old clients sent palette indexes 0-15
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function ipHash(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pc-salt:" + ip));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// constant-time check of the admin secret (set with: wrangler secret put ADMIN_TOKEN)
function isAdmin(request, env) {
  const t = request.headers.get("X-Admin-Token") || "", s = env.ADMIN_TOKEN || "";
  if (!s || t.length !== s.length) return false;
  let d = 0; for (let i = 0; i < s.length; i++) d |= t.charCodeAt(i) ^ s.charCodeAt(i);
  return d === 0;
}
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

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

    // ---- admin (needs the secret token; the only way to bypass the per-IP limit or remove other people's pixels) ----
    if (url.pathname.startsWith("/admin/") && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      let b; try { b = await request.json(); } catch { b = {}; }
      b = b || {};

      if (url.pathname === "/admin/check") return json({ ok: true });

      if (url.pathname === "/admin/place") {                // unlimited, can overwrite
        if (!isInt(b.x, 0, SIZE - 1) || !isInt(b.y, 0, SIZE - 1) || !isInt(b.c, 0, 0xFFFFFF)) return json({ error: "bad request" }, 400);
        await env.DB.prepare("INSERT OR REPLACE INTO pixels (x, y, c, ip) VALUES (?, ?, ?, 'admin')").bind(b.x, b.y, b.c).run();
        return json({ ok: true });
      }

      if (url.pathname === "/admin/erase") {                // delete any pixels in a rectangle (a single pixel = x0=x1, y0=y1)
        if (![b.x0, b.y0, b.x1, b.y1].every(v => isInt(v, 0, SIZE - 1))) return json({ error: "bad request" }, 400);
        const [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)], [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
        // REPLACE swaps each live pixel for an erase marker (c = -1, new id) so everyone's page notices
        const res = await env.DB.prepare(
          "INSERT OR REPLACE INTO pixels (x, y, c, ip) SELECT x, y, -1, '' FROM pixels WHERE c >= 0 AND x BETWEEN ?1 AND ?2 AND y BETWEEN ?3 AND ?4"
        ).bind(x0, x1, y0, y1).run();
        return json({ ok: true, erased: res.meta.changes });
      }

      if (url.pathname === "/admin/import") {               // up to 2000 pixels per call: [[x, y, rgb], ...]
        const list = b.pixels;
        if (!Array.isArray(list) || list.length === 0 || list.length > 2000) return json({ error: "bad request" }, 400);
        for (const p of list) if (!Array.isArray(p) || !isInt(p[0], 0, SIZE - 1) || !isInt(p[1], 0, SIZE - 1) || !isInt(p[2], 0, 0xFFFFFF)) return json({ error: "bad request" }, 400);
        const skipLive = b.overwrite ? "" : "WHERE NOT EXISTS (SELECT 1 FROM pixels q WHERE q.c >= 0 AND q.x = json_extract(value, '$[0]') AND q.y = json_extract(value, '$[1]'))";
        const res = await env.DB.prepare(
          `INSERT OR REPLACE INTO pixels (x, y, c, ip) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), 'admin' FROM json_each(?1) ${skipLive}`
        ).bind(JSON.stringify(list)).run();
        return json({ ok: true, written: res.meta.changes });
      }
    }

    return json({ error: "not found" }, 404);
  },
};
