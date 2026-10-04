# To Do

A simple to-do app that works offline and can be installed like a normal app on your phone or computer.
It is plain HTML, CSS and JavaScript. There is nothing to build and nothing to install.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `app.js`, `store.js`, `sync.js`, `parser.js`, `styles.css` | The app itself |
| `manifest.webmanifest` | Tells browsers the app's name, colours and icons so it can be installed |
| `sw.js` | The service worker. It saves the app on your device so it opens offline |
| `pwa.js` | Registers the service worker and the Install app button |
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

Every later push to `main` re-deploys automatically. The installed app is identified as `/To-Do-App/` (name Brain Dump), so it stays separate from other sites on the same GitHub Pages address.

### Updating the app for people who already installed it

Installed copies are kept on the device. When you change files, edit `VERSION` at the top of `sw.js` (for example `'v1'` to `'v2'`). Users get the new version the next time they open the app, once it has loaded a second time. Old cached files are cleaned up automatically.

## Install it on your device

Open the online address and tap **Install app** in the header. The installed name is **Brain Dump**. In Chrome and Edge, when the browser offers to install, that tap opens the browser’s own install prompt. There is no app store. On iPhone or iPad, and in browsers that do not offer a prompt, the same button opens a short dialog with the steps for that browser. On iPhone or iPad that is Share, then Add to Home Screen. The button is hidden when the app is already installed.

## How dates are read

Weeks run Monday to Sunday.

- **Wednesday**, **this Wednesday**, **on Wednesday**, and **by Wednesday** mean the next time that weekday comes. If today is that weekday, they mean today.
- **Next Wednesday** means the Wednesday of next week. The word "next" stays with the weekday, so this does not turn into Monday. From Friday 2 October 2026, next Wednesday is **Wednesday 7 October 2026** (the week of Monday 5 October through Sunday 11 October). Wednesday 14 October is the week after that.
- **Next week** on its own means Monday of next week, on purpose. **Next week on Wednesday** means that Wednesday, not Monday.
- Short names such as wed, thurs, and tues need a word like next, this, on, or by.

## Good to know

- Tap a task to edit the title, date, time, and an optional note. A task with a note shows a short preview in the list, and the search box looks through notes too. Notes are included in backups, and they travel with the task when sync is on.
- Your to-dos are stored on this device and the app works offline. When you are online, the same list is shared automatically with every device that opens the app. A switch at the bottom turns that sync off on this device.
- Clearing your browser data for the site will erase your to-dos.
- After the first visit the app opens without internet.
