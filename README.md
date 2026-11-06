# 1000×1000 Pixel Canvas

Frontend: static files on GitHub Pages. Backend: a Cloudflare Worker + D1 database (free plan, no card).
Each IP address may place **1000 pixels max** (enforced in the Worker). Pixels are permanent.

## Setup
1. Free account at https://dash.cloudflare.com/sign-up
2. In a terminal:
   ```
   cd worker
   npx wrangler login
   npx wrangler d1 create pixel-canvas        # copy the database_id into wrangler.toml
   npx wrangler d1 execute pixel-canvas --remote --file=schema.sql
   npx wrangler deploy                        # prints https://pixel-canvas.<you>.workers.dev
   ```
3. Put that URL in `config.js`.
4. Push to GitHub, then Settings → Pages → Deploy from branch → main / root.

## Notes
- People behind the same Wi-Fi/VPN share an IP, so they share the 5 pixels; someone with a VPN can get more.
- Free tier: 100k D1 writes/day, 100k Worker requests/day. Clients poll every 3s, so ~30k visitor-minutes/day before the request cap.

## Backup
The canvas lives only in the D1 database. To save a copy: `cd worker && npx wrangler d1 export pixel-canvas --remote --output=backup.sql`

## Eraser
You can erase only your own pixels (matched by IP on the server). Erasing frees one of your pixel slots. Erased cells keep a marker row (c = -1) so other open pages learn about the removal.

## Admin (owner only)
Admin powers need a secret token, stored as the Worker secret `ADMIN_TOKEN` (never in this repo; set with `npx wrangler secret put ADMIN_TOKEN`).
In the page press **Shift+A** (or double-click the title) and enter the token. You get unlimited pixels, can erase anyone's pixel (Eraser) or a whole area, and can import an image (max 25,000 pixels per import; every pixel costs ~3 of Cloudflare's 100k free daily database writes).

## Draw mode
The **Drag: move/draw** button (or `B`) switches dragging from panning to painting. Strokes are sent in batches via `/place-many` (same per-IP limit; live pixels are never overwritten). Hold Space or use the right/middle mouse button to pan while drawing. Works at 4× zoom or closer.

## Line tool
The **Line** button (or `L`) draws straight lines of any length: drag from start to end, or click the start, pan/zoom, then click the end. Shift snaps to horizontal/vertical/45°; Esc cancels. Lines skip taken pixels, count against your limit (refused if it wouldn't fit), and are sent in batches of 500.
