# Doc Scanner for Google Drive & Classroom

A web app that turns a laptop's built-in camera into a document scanner. Hold pages up to the
camera and they are captured, straightened and cleaned up, then saved to Google Drive as a single
PDF or turned in to a Google Classroom assignment.

It's a static site (hosted free on GitHub Pages) with no server. Everything runs in the
browser, and people sign in with their own Google account, so scans go to their own Drive.

## Features

- **Multi-page scanning.** Capture as many pages as you need. Drag thumbnails to reorder them, click one to edit it, delete with undo.
- **Automatic edge detection.** The page outline is found live and drawn over the camera view. It looks for the paper itself (a bright, nearly colourless region that isn't skin) as well as for outlines, so faces, bookshelves and windows behind you aren't mistaken for the page. If part of the page is out of view, it asks you to move it back instead of guessing.
- **Perspective & skew correction.** Each page is warped flat into a rectangle. Rotate in 90° steps, or drag the corners yourself (a magnifier helps you place them exactly).
- **Focus detection.** A live focus meter measures sharpness on the page itself. It compares each frame with what your camera normally manages, which suits laptop webcams (most are fixed-focus) and still rejects frames blurred by hand shake. The outline turns green when the page is found, steady and sharp.
- **Sharpest-frame capture.** Each capture grabs a quick burst of frames and keeps the sharpest.
- **Finger removal.** Holding the page by its edges is fine: fingers that reach in from the edge are detected by skin colour and painted over with the paper colour. Skin is also ignored when finding the page edges, so a thumb over the edge doesn't throw the outline off. It can be turned off per page in the editor.
- **Auto-capture.** When the outline is green for about 0.6 s the page is captured, with a flash and click. Show the next page and it captures again. It never captures the same page twice: it waits for the page to move first.
- **Clean-up looks.** *Enhanced* (shadow removal plus contrast, the default), *Original*, *Grayscale*, *B&W*. You can apply one look to every page.
- **Quick folder picking.** Your last folder is preselected and recent folders are one click away. You can also browse My Drive and **shared drives**, search all of Drive, or create a folder without leaving the dialog.
- **Google Classroom turn in.** Pick a class and assignment and the PDF is attached and turned in. See [Classroom: what works how](#classroom-what-works-how).
- **Teacher tools.** Teachers can create "scan assignments" that support one-click turn in, and copy scanner links for any assignment.
- Upload or drag in photos too. A camera picker appears for external or document cameras. Keyboard shortcuts: `Space` captures, `A` toggles auto-capture, `S` saves, `Esc` closes. Dark mode follows the system. It can be installed as an app from Chrome's address bar.

Nobody has to sign in to scan. Google sign-in appears the first time someone clicks **Save**.

## Setup

You need two things: GitHub Pages to host the site, and a Google Cloud project so people can sign in.
Use your **school Google account** for the Google Cloud part. That lets you make the app "Internal"
to your school, which skips Google's app review.

### 1. Turn on GitHub Pages

1. Merge this branch into `main`.
2. In the repository on GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Source: Deploy from a branch**, **Branch: `main`**, folder **`/docs`**, and click **Save**.
4. After a minute the site is live at `https://<your-github-username>.github.io/<repo-name>/`
   (for this repo: `https://akoch-cls.github.io/google-drive-scanner/`).

### 2. Create the Google sign-in client

1. Open <https://console.cloud.google.com/> signed in with your school account, and create a new project (for example "Doc Scanner").
2. **Turn on the APIs.** Go to **APIs & Services → Library**, then search for and **Enable** both **Google Drive API** and **Google Classroom API**.
3. **Set up the consent screen.** Go to **Google Auth Platform** (or **APIs & Services → OAuth consent screen**):
   - App name "Doc Scanner", plus your email as the support and developer contact.
   - **Audience: Internal.** Only people in your school can use it, and Google doesn't need to review the app.
4. **Create the client.** Under **Clients** (or **Credentials → Create credentials → OAuth client ID**):
   - Application type: **Web application**
   - **Authorized JavaScript origins:** `https://akoch-cls.github.io` (just the origin, with no path and no trailing slash). Also add `http://localhost:8080` if you want to test locally.
   - Click **Create** and copy the **Client ID**. It looks like `123456789012-abc….apps.googleusercontent.com`.
5. Put it in [`docs/config.js`](docs/config.js):
   ```js
   window.SCANNER_CONFIG = {
     clientId: '123456789012-abc….apps.googleusercontent.com'
   };
   ```
   Commit and push. The client ID isn't a secret: it only works on the origins you listed.

### 3. Check your Google Workspace admin settings

Ask your admin to check these if sign-in fails or Classroom shows errors:

- **Admin console → Apps → Google Workspace → Classroom → Data access.** "Users can authorize apps to access their Google Classroom data" must be on.
- **Admin console → Security → Access and data control → API controls.** If third-party apps are restricted, add the OAuth client ID from step 2 as a **Trusted** app.

### Permissions the app asks for

| Permission | Why |
| --- | --- |
| See and edit Google Drive files (`drive`) | Browse and search folders, and save the PDF where you choose |
| See your Classroom classes (`classroom.courses.readonly`) | List classes |
| See and turn in your Classroom work (`classroom.coursework.me`) | List assignments, attach the PDF, turn in |
| Manage coursework for your students (`classroom.coursework.students`) | Teachers only: requested the first time a teacher creates a scan assignment |

Sign-ins last about an hour per browser tab. After that, clicking Save asks again; there's normally no password to retype.

## Classroom: what works how

Google only lets an app attach files to, and turn in, assignments **created by that same app**
(the same Google Cloud project). That is a Classroom API rule, so no app can get around it. Doc
Scanner handles both cases:

| Assignment | What happens |
| --- | --- |
| Created in Doc Scanner's **Teacher tools** (badge "⚡ One-click turn in") | The PDF is attached and turned in automatically. |
| Created normally in Classroom | The PDF is saved to the student's Drive (folder `Scanned Assignments`). The app then opens the assignment with step-by-step instructions to attach the file (it's at the top of Drive → Recent) and click Turn in. |

**Teacher tools** (the button appears for people who teach a class):

- **New scan assignment** posts an assignment that supports one-click turn in. The scanner link goes into the instructions automatically.
- **Link for existing assignment** copies a link like `…/google-drive-scanner/?course=123&assignment=456`. Opening it starts the scanner with that assignment preselected and the Save button reading "Turn in to Classroom".

## Tips for good scans

- Hold the page flat and fill most of the view. A **darker background** behind the page makes edge detection much more reliable.
- Light from the front or side works best. *Enhanced* removes most shadows.
- Hold the page by its side edges rather than covering the corners. Fingers along an edge are removed automatically, but a corner hidden under a thumb can't be found.
- If the outline isn't found (low contrast, hands covering corners), press `Space` and drag the corners in the editor.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Setup needed" when clicking Save | `docs/config.js` still has the placeholder client ID. |
| Google says `origin_mismatch` or "redirect_uri" error | The site's origin (e.g. `https://akoch-cls.github.io`) isn't in the client's **Authorized JavaScript origins**. Changes can take a few minutes to apply. |
| Sign-in pop-up doesn't appear | Allow pop-ups for the site. |
| "API is not turned on" | Enable the Drive API and Classroom API in the Google Cloud project. |
| Camera blocked | Click the camera icon in the address bar and allow it, then **Try again**. |
| On a Mac, the picture keeps panning/zooming to follow your face and the page never holds still | Turn off **Center Stage**: while the camera is on, click the green camera icon in the menu bar (or Control Center → Video Effects). Turn off **Portrait** too. Web pages can't change this setting. |
| It outlines the wrong thing, or won't capture the page | Press **D** (or open the site with `?debug` on the end of the address) to see what the scanner sees: paper-coloured areas in white, skin in red, every shape it considered in yellow, and its choice in green. **Save camera frame** downloads the current picture, which is the most useful thing to include in a problem report. |
| "Move the page back so all four corners are in view" | Part of the page is outside the picture. Move it further from the camera, or lower the screen a little. |
| Top bar says **Manual crop only** | OpenCV.js couldn't load from `docs.opencv.org` or `cdn.jsdelivr.net` (often a web filter). Allow those hosts, or put `opencv.js` in `docs/` and add `'opencv.js'` to `CV_URLS` in `docs/app.js`. |

## How it works

| Step | File | Technique |
| --- | --- | --- |
| Page detection | `vision.js` → `detectQuad` | Candidates from paper-coloured regions (Otsu brightness split, low saturation, not skin, morphological close/open) and from Canny outlines, each reduced to 4 corners via convex hull + polygon approximation. Each is scored by how paper-coloured its inside is, its contrast with the surroundings, size and closeness to the centre (`scoreQuad`). Runs with OpenCV.js on a 480-px frame about 10× per second. |
| Focus | `vision.js` → `sharpness` | Variance of the Laplacian on a full-resolution crop at the page centre, compared with the camera's typical value (80th percentile of the last ~2.5 s). Captures keep the sharpest of a 5-frame burst. |
| Fingers | `vision.js` → `skinMask`, `removeFingers` | Skin colour judged relative to the paper's own tint (YCbCr). Skin regions touching the page border, plus the darker rim and shadow next to them, are filled from the surrounding paper colour; skin is ignored during edge detection. |
| Steadiness | `vision.js` → `meanAbsDiff` | Frame-to-frame change, plus how much the outline moves. |
| De-skew | `vision.js` → `warp` | Projective (homography) warp with bilinear sampling. |
| Clean-up | `vision.js` → `applyFilter` | Estimates the paper brightness (max-filter + blur on a shrunken copy), divides it out to remove shadows, then applies a levels curve. |
| PDF | `google.js` → `buildPdf` | Embeds each JPEG as-is (no re-encoding), with pages sized to 11 in on the long edge. |
| Google | `google.js` | Google Identity Services token sign-in, plus the Drive v3 and Classroom v1 REST APIs called directly from the browser. |

Detection and focus thresholds are in the `CONFIG` block at the top of `docs/app.js`.

## Local testing

```bash
node dev/serve.js --mock
```

Open <http://localhost:8080>. In `--mock` mode the Google APIs are replaced by fake folders, classes and
assignments (`dev/mock-api.js`), so you can try everything without any Google setup. Add
`?course=c1&assignment=w1` to the URL to try a Classroom deep link.

Run `node dev/serve.js` without `--mock` to use real Google sign-in. That needs
`http://localhost:8080` in the client's Authorized JavaScript origins.

## Project layout

```
docs/                  the website (GitHub Pages serves this folder)
  index.html           page markup
  styles.css           styles
  config.js            your Google OAuth client ID
  vision.js            image processing: detection, focus, warp, filters
  google.js            sign-in, Drive, Classroom, PDF builder
  app.js               UI: camera loop, auto-capture, editor, save flows
  manifest.webmanifest, icon.svg   lets Chrome install it as an app
dev/
  serve.js             local server (camera needs localhost or https)
  mock-api.js          fake Google APIs for --mock
```
