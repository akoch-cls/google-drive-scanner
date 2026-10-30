# Doc Scanner for Google Drive & Classroom

A Google Apps Script web app that turns a laptop's built-in camera into a document scanner.
Hold pages up to the camera and they are captured, straightened and cleaned up, then saved
to Google Drive as a single PDF or turned in to a Google Classroom assignment.

## Features

- **Multi-page scanning.** Capture as many pages as you need. Drag thumbnails to reorder them, click one to edit it, delete with undo.
- **Automatic edge detection.** The page outline is found live with OpenCV.js and drawn over the camera view.
- **Perspective & skew correction.** Each page is warped flat into a rectangle. Rotate in 90° steps, or drag the corners yourself (a magnifier helps you place them exactly).
- **Focus detection.** A live focus meter measures sharpness (variance of the Laplacian) on the page itself. The outline turns green only when the page is found, held steady and in focus.
- **Auto-capture.** When the outline is green for about 0.7 s the page is captured, with a flash and click. Show the next page and it captures again. It never captures the same page twice: it waits for the page to move first.
- **Clean-up looks.** *Enhanced* (shadow removal plus contrast, the default), *Original*, *Grayscale*, *B&W*. You can apply one look to every page.
- **Quick folder picking.** Your last folder is preselected and recent folders are one click away. You can also browse, search all of Drive, or create a folder without leaving the dialog.
- **Google Classroom turn in.** Pick a class and assignment and the PDF is attached and turned in. See [Classroom: what works how](#classroom-what-works-how).
- **Teacher tools.** Teachers can create "scan assignments" that support one-click turn in, and copy scanner links for any assignment.
- Upload or drag in photos too, for example from a phone. A camera picker appears for external or document cameras. Keyboard shortcuts: `Space` captures, `A` toggles auto-capture, `S` saves, `Esc` closes. Dark mode follows the system.

## Setup

### Option A: copy and paste (no tools needed)

1. Go to <https://script.google.com> and click **New project**. Name it "Doc Scanner".
2. Click **Project Settings** (gear icon) and tick **Show "appsscript.json" manifest file in editor**.
3. In the editor, replace the contents of `appsscript.json` and `Code.gs` with the files in [`src/`](src).
4. Add four HTML files with **+ → HTML**, named exactly `Index`, `Styles`, `Vision` and `App` (the editor adds `.html`). Paste the matching files from `src/`.
5. Click **Deploy → New deployment**, choose type **Web app**, and set:
   - *Execute as:* **User accessing the web app** (files go to each person's own Drive)
   - *Who has access:* **Anyone within your domain** (the manifest default; use "Anyone with Google account" for personal accounts)
6. Click **Deploy**, approve the permissions, and open the web app URL.

### Option B: clasp

```bash
npm install -g @google/clasp
```

```bash
clasp login
```

```bash
clasp create --type webapp --title "Doc Scanner" --rootDir src
```

```bash
clasp push
```

Then deploy as in step 5 above. `.clasp.json.example` shows the expected config if you link an existing script.

### Classroom service

The manifest already enables the **Google Classroom API** advanced service. If the editor shows `Classroom is not defined`, add it under **Services → + → Google Classroom API**.

### For Google Workspace admins

The app asks for Drive and Classroom scopes. Students in a Workspace for Education domain may see "This app isn't verified" or be blocked until an admin trusts the script. Mark it trusted under **Admin console → Security → API controls → App access control**, using the script's OAuth client ID from its Google Cloud project.

## Classroom: what works how

Google only lets an app attach files to, and turn in, assignments **created by that same app**. That is a Classroom API rule, so no app can get around it. Doc Scanner handles both cases:

| Assignment | What happens |
| --- | --- |
| Created in Doc Scanner's **Teacher tools** (badge "⚡ One-click turn in") | The PDF is attached and turned in automatically. |
| Created normally in Classroom | The PDF is saved to the student's Drive (folder `Scanned Assignments`). The app then opens the assignment with step-by-step instructions to attach the file (it is at the top of Drive → Recent) and click Turn in. |

**Teacher tools** (shown only to people who teach a class):

- **New scan assignment** posts an assignment that supports one-click turn in. The scanner link goes into the instructions automatically.
- **Link for existing assignment** copies a link like `…/exec?course=123&assignment=456`. Opening it starts the scanner with that assignment preselected and the Save button reading "Turn in to Classroom".

Only teachers using **the same deployment** get one-click turn in, because the assignment has to be created by this script's Cloud project.

## Tips for good scans

- Hold the page flat and fill most of the view. A **darker background** behind the page makes edge detection much more reliable.
- Light from the front or side works best. *Enhanced* removes most shadows.
- If the outline isn't found (low contrast, hands covering corners), press `Space` and drag the corners in the editor.

## How it works

All image processing happens in the browser:

| Step | Where | Technique |
| --- | --- | --- |
| Page detection | `Vision.html` → `detectQuad` | OpenCV.js: blur, auto-threshold Canny, dilate, contours, convex hull, 4-point polygon approximation. Runs on a 480-px frame about 10× per second. |
| Focus | `Vision.html` → `sharpness` | Variance of the Laplacian on a full-resolution crop at the page centre, compared with the recent best. Also needs an absolute minimum. |
| Steadiness | `Vision.html` → `meanAbsDiff` | Frame-to-frame change, plus how much the outline moves. |
| De-skew | `Vision.html` → `warp` | Projective (homography) warp with bilinear sampling. |
| Clean-up | `Vision.html` → `applyFilter` | Estimates the paper brightness (max-filter + blur on a shrunken copy), divides it out to remove shadows, then applies a levels curve. |

The server (`Code.gs`) receives finished JPEGs and wraps them in a PDF itself, with one image per page and pages sized to 11 in on the long edge. Nothing is re-encoded and there are no external services. It then saves the PDF with `DriveApp` and uses the Classroom advanced service for submissions.

OpenCV.js (~10 MB) loads from `docs.opencv.org`, with jsDelivr as a fallback, and the browser caches it after the first visit. If neither can be reached, for example because of a school web filter, the chip in the top bar says **Manual crop only**. Scanning still works, but you drag the corners yourself. To fix that, allow those hosts, or host `opencv.js` somewhere reachable and add it to `CV_URLS` in `App.html`.

Detection and focus thresholds are in the `CONFIG` block at the top of `App.html`.

## Local preview

You can try the UI without deploying. A mock backend stands in for Apps Script:

```bash
node dev/build-preview.js
```

```bash
npx http-server dev -p 8080
```

Open <http://localhost:8080/preview.html>. Camera access needs `localhost` or https. Add `?course=c1&assignment=w2` to the URL to try the Classroom deep link.

## Project layout

```
src/
  appsscript.json   manifest: scopes, Classroom service, web app settings
  Code.gs           server: folders, PDF builder, Drive saving, Classroom
  Index.html        page markup
  Styles.html       CSS
  Vision.html       image processing (detection, focus, warp, filters)
  App.html          UI logic (camera loop, auto-capture, editor, save flows)
dev/
  build-preview.js  builds dev/preview.html for local testing
  mock-server.js    fake google.script.run
```
