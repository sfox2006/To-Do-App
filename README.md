# To Do

A simple to-do app that works offline and can be installed like a normal app on your phone or computer.
It is plain HTML, CSS and JavaScript. There is nothing to build and nothing to install.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `app.js`, `store.js`, `parser.js`, `styles.css` | The app itself |
| `manifest.webmanifest` | Tells browsers the app's name, colours and icons so it can be installed |
| `sw.js` | The service worker. It saves the app on your device so it opens offline |
| `pwa.js` | Registers the service worker, shows the "Install app" button and the iPhone hint |
| `icons/` | App icons. `icons/generate_icons.py` re-creates them (needs Python with Pillow) |
| `.github/workflows/pages.yml` | Publishes the app to GitHub Pages |

## Run it on your computer

The service worker only works over `http://localhost` or `https`, so don't just double-click `index.html`. Start a tiny local web server instead:

```bash
cd todo-app
python3 -m http.server 8000
```

Then open <http://localhost:8000> in Chrome, Edge, Safari or Firefox. Press `Ctrl+C` in the terminal to stop it.

(If you don't have Python, `npx serve .` works too.)

## Put it online with GitHub Pages (free)

1. Create a new repository on GitHub and push this folder to it, with the files at the top level of the repo, on the `main` branch.
2. On GitHub, open the repo's **Settings → Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `main` (or open the **Actions** tab and run **Deploy to GitHub Pages**). After a minute or so your app is live at `https://<your-username>.github.io/<repo-name>/`.

Every later push to `main` re-deploys automatically. All paths in the app are relative, so it works fine from the `/<repo-name>/` subpath.

### Updating the app for people who already installed it

Installed copies are kept on the device. When you change files, edit `VERSION` at the top of `sw.js` (for example `'v1'` to `'v2'`). Users get the new version the next time they open the app, once it has loaded a second time. Old cached files are cleaned up automatically.

## Install it on your device

You need to open the **online** (https) address, or `localhost` on your own computer.

### iPhone / iPad (Safari)
1. Open the app's address in **Safari**. Other iPhone browsers can't install apps in the same way.
2. Tap the **Share** button (square with an arrow pointing up).
3. Scroll down and tap **Add to Home Screen**, then tap **Add**.

The app now has its own icon on your home screen and opens full screen.

### Android (Chrome)
1. Open the app's address in Chrome.
2. Tap the **Install app** button in the app, or open the Chrome menu (⋮) and choose **Install app** or **Add to Home screen**.
3. Confirm. The app appears in your app drawer and on your home screen.

### Laptop or desktop (Chrome or Edge)
1. Open the app's address.
2. Click the **Install app** button in the app. You can also click the install icon at the right end of the address bar.
3. Confirm. The app opens in its own window and can be pinned to your taskbar or dock.

Safari on a Mac: choose **File → Add to Dock**. Firefox on desktop does not support installing web apps.

## Good to know

- Tap a task to edit the title, date, time, and an optional note. A task with a note shows a short preview in the list, and the search box looks through notes too. Notes stay on this device and are included in backups.
- Your to-dos are stored on the device you use, in the browser's own storage. They are not synced between devices.
- Clearing your browser data for the site will erase your to-dos.
- After the first visit the app opens without internet.
