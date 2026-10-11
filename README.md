# 家庭菜单 Family Meals

Weekly meal planner + grocery list PWA. Plain HTML/CSS/JS, no build step.

## Run
- **Local test:** open `index.html` in a browser. Everything works except install-to-home-screen and offline mode (browsers block those on `file://`).
- **On phones:** host the folder on any HTTPS static host (e.g. GitHub Pages, Netlify, Cloudflare Pages), open the URL, then
  - iPhone (Safari): Share → Add to Home Screen
  - Android (Chrome): ⋮ → Install app / Add to Home screen

## Data
Stored on each device (IndexedDB). Nothing is uploaded anywhere.

Sharing is by file, done separately for each kind:
- **Dish database** (Dishes tab → Share / Import): `dishes-YYYY-MM-DD.json`, includes photos. Import offers *Merge* or *Replace all*.
- **Weekly schedule** (Week tab → Share / Import): `schedule-<monday>.json`, holds only day, meal, dish ID and dish name. Dishes are looked up by ID, then by name.

## Files
- `index.html`: page shell
- `app.js`: all app logic (views, dish form, picker, grocery list, import/export)
- `i18n.js`: English / Chinese strings
- `store.js`: IndexedDB storage (localStorage fallback)
- `sw.js`, `manifest.webmanifest`, `icons/`: PWA install and offline support. Bump `CACHE` in `sw.js` after changing files.
