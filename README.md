# 1000×1000 Pixel Canvas

Frontend: static files on GitHub Pages. Backend: a Cloudflare Worker + D1 database (free plan, no card).
Each IP address may place **500 pixels max** (enforced in the Worker). Pixels are permanent.

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
