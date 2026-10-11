# 家庭菜单 Family Meals

Weekly meal planner + grocery list PWA. Plain HTML/CSS/JS, no build step.

## Run
- **Local test:** open `index.html` in a browser. Everything works except install-to-home-screen and offline mode (browsers block those on `file://`).
- **On phones:** host the folder on any HTTPS static host (e.g. GitHub Pages, Netlify, Cloudflare Pages), open the URL, then
  - iPhone (Safari): Share → Add to Home Screen
  - Android (Chrome): ⋮ → Install app / Add to Home screen

## Data
By default everything stays on the device (IndexedDB).

**Family sync (Firebase Firestore):** tap ☁️ in the header to create a family or join one with its 8-character family code (or an invite link `?family=CODE`). Everyone in the family sees and edits the same dishes, menu and grocery list, offline included; changes sync when back online. Anyone with the code has access, so only share it with family. Sync needs the app opened over http(s), not as a local file.

Setup: create a Firebase project with **Anonymous** sign-in and a **Firestore** database, publish `firestore.rules`, and put the web app config in `firebase-config.js`.

File sharing still works, separately for each kind:
- **Dish database** (Dishes tab → Share / Import): `dishes-YYYY-MM-DD.json`, includes photos. Import offers *Merge* or *Replace all*.
- **Weekly schedule** (Menu tab → Share / Import): `schedule-<monday>.json`, holds only day, meal, dish ID and dish name.

Dish photos are cropped square in the app and saved as 800×800 JPEG (≤150 KB).

## Files
- `index.html`: page shell
- `app.js`: app logic (views, dish form, picker, grocery list, import/export, sync panel)
- `cropper.js`: square photo cropper
- `sync.js`: Firestore family sync
- `firebase-config.js`: Firebase project config (null = no sync)
- `firestore.rules`: Firestore security rules (paste into the Firebase console)
- `i18n.js`: Chinese / English strings
- `store.js`: on-device storage (IndexedDB, localStorage fallback)
- `sw.js`, `manifest.webmanifest`, `icons/`: PWA install and offline support. Bump `CACHE` in `sw.js` after changing files.
