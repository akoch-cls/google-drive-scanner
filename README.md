# Doc Scanner for Google Drive & Classroom

A web app that turns a laptop's built-in camera into a document scanner. Hold pages up to the
camera and they are captured, straightened and cleaned up, then saved to Google Drive as a single
PDF or turned in to a Google Classroom assignment.

It's a static site (hosted free on GitHub Pages) with no server. Everything runs in the
browser, and people sign in with their own Google account, so scans go to their own Drive.

## Features

- **Multi-page scanning.** Capture as many pages as you need. Drag thumbnails to reorder them, click one to edit it, delete with undo.
- **Automatic edge detection.** The page outline is found live and drawn over the camera view. It finds the page by its writing, then follows the paper out to its edges, so faces, ceiling lights, walls, doors and windows aren't mistaken for the page, even when the camera's exposure makes the page darker than the wall behind it. (A blank page isn't found automatically: press Space and drag the corners.) If part of the page is out of view, it asks you to move it back instead of guessing.
- **Perspective & skew correction.** Each page is warped flat into a rectangle. Rotate in 90° steps, or drag the corners yourself (a magnifier helps you place them exactly).
- **Focus detection.** A live focus meter measures sharpness on the page itself. It compares each frame with what your camera normally manages, which suits laptop webcams (most are fixed-focus) and still rejects frames blurred by hand shake. The outline turns green when the page is found, steady and sharp.
- **Sharpest-frame capture.** Each capture grabs a quick burst of frames and keeps the sharpest.
- **Finger removal.** Holding the page by its edges is fine: fingers that reach in from the edge are detected by skin colour and painted over with the paper colour. Skin is also ignored when finding the page edges, so a thumb over the edge doesn't throw the outline off. It can be turned off per page in the editor.
- **Auto-capture.** When the outline is green for about 0.6 s the page is captured, with a flash and click. Show the next page and it captures again. It never captures the same page twice: it waits for the page to move first.
- **Clean-up looks.** *Enhanced* (shadow removal plus contrast, the default), *Original*, *Grayscale*, *B&W*. You can apply one look to every page.
- **Quick folder picking.** Your last folder is preselected and recent folders are one click away. You can also browse My Drive and **shared drives**, search all of Drive, or create a folder without leaving the dialog.
- **Google Classroom turn in.** Pick a class and assignment and the PDF is attached and turned in. See [Classroom: what works how](#classroom-what-works-how).
- **Teacher tools.** Teachers can create "scan assignments" that support one-click turn in, and copy scanner links for any assignment.
- **Classroom add-on (optional).** Teachers add Doc Scanner to *any* assignment from Classroom's **Add-ons** menu. Students scan inside the assignment and turn in with Classroom's own button. See [Classroom add-on](#classroom-add-on).
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
| Classroom add-on permissions (`classroom.addons.student`, `classroom.addons.teacher`) | Add-on only: attach the scanner to an assignment, and know whose submission a scan belongs to |
| See class rosters and their email addresses (`classroom.rosters.readonly`, `classroom.profile.emails`) | Add-on only, students: share their scan with the class's teachers |

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

## Classroom add-on

The add-on puts the scanner **inside Classroom** and works with assignments teachers create the normal way.
The GitHub Pages site keeps working exactly as before. Both run the **same code**, so they can't fall out
of sync:

| Who | Classroom opens | Code |
| --- | --- | --- |
| Teacher, adding it to an assignment (Add-ons menu) | `addon.html?view=setup` | `addon.js` |
| Student, opening the attachment | `index.html?addon=student`: the regular scanner, in add-on mode | `app.js` (same scanner as the site) |
| Teacher, opening the attachment | `addon.html?view=teacher`: every student's scan | `addon.js` |
| Teacher, grading one student | `addon.html?view=review`: that student's PDF | `addon.js` |

All Google calls for both live in `google.js`. A scanner fix or improvement ships to the website and the add-on
with the same push.

### How it works for students

1. They open the assignment in Classroom and click the **Scan your work** attachment.
2. The scanner opens inside Classroom. They scan and click **Submit to Classroom**. The first time, Google asks for permission.
3. The PDF goes to their Drive (`Scanned Assignments`), shared view-only with the class's teachers. If they scan again, the new PDF replaces the old one.
4. They click Classroom's own **Turn in** button. Add-ons can't turn work in themselves; Classroom keeps that button.

If Classroom doesn't let the scanner use the camera inside the assignment, it says so and offers **Open in a new tab**.
The scan still goes to the same assignment. There's also an **Open in new tab ↗** button for a bigger view.

Teachers see the scan in Classroom's grading view (the student work review pane) and on the attachment itself.
Nothing extra is stored anywhere: the student's Drive holds the file, and the scan is linked to the assignment by
private app properties that only this app can read.

### Setting it up

Use the **same Google Cloud project** as the website. The add-on has to be published from the project that owns
the OAuth client.

1. **Check licensing.** Teachers need a license that includes Classroom add-ons. Google has offered them with
   **Google Workspace for Education Plus** or the **Teaching and Learning Upgrade**. Check what your school has
   before going further.
2. **Enable the APIs.** In **APIs & Services → Library**, enable the **Google Workspace Marketplace SDK** (Drive and
   Classroom are already on).
3. **Add the scopes** to the consent screen (**Google Auth Platform → Data access**):
   `classroom.addons.student`, `classroom.addons.teacher`, `classroom.rosters.readonly`, `classroom.profile.emails`
   (plus the ones already listed above).
4. **Configure the add-on.** Open **Google Workspace Marketplace SDK → App configuration**:
   - App visibility: **Private** (your school only).
   - Installation: admin-only install is simplest.
   - App integrations: **Classroom add-on**.
     - **Attachment Setup URI:** `https://akoch-cls.github.io/google-drive-scanner/addon.html?view=setup`
     - **Allowed attachment URI prefixes:** `https://akoch-cls.github.io/google-drive-scanner/`
   - OAuth scopes: the same list as the consent screen (`openid`, `email`, `drive`, `classroom.courses.readonly`,
     `classroom.coursework.me`, `classroom.coursework.students` and the four above).
   - Fill in the developer details, then go to **Store listing**, add the required icons and support links, and click **Publish**.
     Private apps aren't reviewed by Google.
5. **Install it for the school.** In the **Admin console → Apps → Google Workspace Marketplace apps**, find Doc Scanner
   (under your domain's private apps) and **install** it for the teachers' and students' organizational units. That also
   pre-approves its permissions.
6. **Teachers:** create an assignment in Classroom, click **Add-ons → Doc Scanner**, keep or change the title,
   click **Add to assignment**, and post.

### Things to check in a test class first

These can't be tested outside a real Classroom domain:

- **Camera inside Classroom.** Whether Classroom lets an add-on use the camera in its frame isn't documented. If it
  doesn't, students get the "Open in a new tab" button; the flow still works, with one extra click.
- **Sign-in inside Classroom.** Google's sign-in pop-up opens from the frame. If the browser blocks pop-ups,
  students need to allow them for the site once.
- **Sharing with teachers.** The scan is shared with the class's teacher group, or with each teacher's email if
  Classroom doesn't give students the group. A co-teacher added later won't see scans submitted before they joined
  until the student scans again.

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
| Top bar doesn't say **· hand tracking** | The hand tracker couldn't load from `cdn.jsdelivr.net` / `storage.googleapis.com`. Scanning still works using skin colour to find fingers; allow those hosts for better finger handling. |
| Top bar says **Manual crop only** | OpenCV.js couldn't load from `docs.opencv.org` or `cdn.jsdelivr.net` (often a web filter). Allow those hosts, or put `opencv.js` in `docs/` and add `'opencv.js'` to `CV_URLS` in `docs/app.js`. |

## How it works

| Step | File | Technique |
| --- | --- | --- |
| Page detection (coarse) | `vision.js` → `detectQuad` | Candidate outlines from three sources: **(1) writing first** (`inkSeededCandidates`): thin dark strokes on a colourless background, dense ink = text zone, paper colour sampled around it and the region grown out to the page edge, which works whatever the exposure; **(2)** paper-coloured regions; **(3)** Canny outlines; plus **(4)** the previous frame's page (a temporal prior, as in the best SmartDoc 2015 entries). Region boundaries become 4 sides by sequential RANSAC line fitting over boundary points away from hands (`quadFromContour`), so a corner under a thumb is recovered where its two sides meet. Candidates are rejected if off-centre, a blown-out light with no writing, under 1% writing, or not paper-coloured (`scoreQuad`). The top 4 are re-ranked by edge support after refinement. Runs with OpenCV.js on a 480-px frame. |
| Page edges (precise) | `vision.js` → `refineQuad` | Detect low, refine high: each side is searched across a narrow band for the strongest brightness/colour *step* (not thin ink lines), points under fingers are skipped, and a line is fitted with RANSAC; corners are the line intersections. Done at 960 px every frame and at full camera resolution on the captured frame. |
| Hands | `hands.js` | MediaPipe Hand Landmarker (pretrained, runs in the browser): 21 points per hand, rasterised into a finger mask. Edge points under it are ignored, and auto-capture waits while fingers cover more than 3% of the page interior ("Move your fingers to the edge of the page"). Falls back to the skin-colour mask if the model can't load. |
| Tracking | `app.js` → `updateQuad` | One Euro filter on the corners (Casiez et al., 2012); the outline appears only after 3 consistent detections and is kept through 4 missed frames. |
| Focus | `vision.js` → `sharpness` | Tenengrad (Sobel gradient energy above a noise floor), which holds up better than Laplacian measures on noisy webcams (Pertuz et al., 2013), on a full-resolution crop inside the page, compared with the camera's typical value over ~2.5 s. Captures keep the sharpest of a 5-frame burst. |
| Fingers in the scan | `vision.js` → `skinMask`, `removeFingers` | Skin colour judged relative to the paper's own tint. Skin regions touching the page border, plus their darker rim and shadow, are filled from the surrounding paper colour. |
| Steadiness | `vision.js` → `meanAbsDiff` | Frame-to-frame change, plus how much the outline moves. |
| De-skew | `vision.js` → `estimateAspect`, `warp` | The page's real aspect ratio is recovered from the outline's perspective (Zhang & He, whiteboard scanning), snapped to Letter/A4/Legal when close; then a homography warp of the full-resolution frame. Measuring edge lengths in the image instead distorts tilted pages. |
| Clean-up | `vision.js` → `applyFilter` | Estimates the paper brightness (max-filter + blur on a shrunken copy), divides it out to remove shadows, then applies a levels curve. |
| PDF | `google.js` → `buildPdf` | Embeds each JPEG as-is (no re-encoding), with pages sized to 11 in on the long edge. |
| Google | `google.js` | Google Identity Services token sign-in, plus the Drive v3 and Classroom v1 REST APIs called directly from the browser. |

Detection and focus thresholds are in the `CONFIG` block at the top of `docs/app.js`.

Not implemented from the research: a trained page-segmentation or corner network (LDRNet, HU-PageScan) and learned dewarping of curled pages (DewarpNet, DocTr). Both need training data or are too heavy for a laptop in real time; the line-based pipeline above covers the finger-occlusion cases they're best known for.

## Local testing

```bash
node dev/serve.js --mock
```

Open <http://localhost:8080>. In `--mock` mode the Google APIs are replaced by fake folders, classes and
assignments (`dev/mock-api.js`), so you can try everything without any Google setup. Add
`?course=c1&assignment=w1` to the URL to try a Classroom deep link.

The add-on pages, with the query strings Classroom would add:

- Student: <http://localhost:8080/index.html?addon=student&courseId=c1&itemId=w1&attachmentId=att1>
- Teacher set-up: <http://localhost:8080/addon.html?view=setup&courseId=c1&itemId=w1&itemType=courseWork&addOnToken=x>
- Teacher view: <http://localhost:8080/addon.html?view=teacher&asTeacher&courseId=c1&itemId=w1&attachmentId=att1>
- Grading view: <http://localhost:8080/addon.html?view=review&asTeacher&courseId=c1&itemId=w1&attachmentId=att1&submissionId=sub-ada>

Run `node dev/serve.js` without `--mock` to use real Google sign-in. That needs
`http://localhost:8080` in the client's Authorized JavaScript origins.

### Measuring detection accuracy

```bash
python3 dev/eval/make_fixtures.py
```

```bash
npm install --no-save playwright && npx playwright install chromium
```

```bash
node dev/eval/run.js
```

`make_fixtures.py` renders synthetic webcam frames with known page corners: thumbs over the edges, a covered corner, a light wall, a screen-lit face, a ceiling light, strong tilt, a page cut off, and no page. `run.js` scores the detector with the SmartDoc 2015 metrics: IoU, maximum corner error ÷ page perimeter (correct below 0.017), aspect-ratio error, and false detections. Run it before and after changing detection.

To score your own frames, save some with **Save camera frame** (press D), put them in `dev/eval/private/` with a `truth.json` (same format as `dev/eval/fixtures/truth.json`: four corners per frame, or `"expect": "none"`), and run `node dev/eval/run.js dev/eval/private --show`. That folder is git-ignored, since real frames show faces and student work.

## Project layout

```
docs/                  the website (GitHub Pages serves this folder)
  index.html           page markup
  styles.css           styles
  config.js            your Google OAuth client ID
  vision.js            image processing: detection, line refinement, aspect ratio, focus, warp, filters
  hands.js             hand tracking (MediaPipe) → finger mask
  google.js            sign-in, Drive, Classroom, Classroom add-on, PDF builder
  app.js               UI: camera loop, auto-capture, editor, save flows (and the add-on's student view)
  addon.html, addon.js Classroom add-on teacher pages: set-up, all scans, grading view
  manifest.webmanifest, icon.svg   lets Chrome install it as an app
dev/
  serve.js             local server (camera needs localhost or https)
  mock-api.js          fake Google APIs for --mock
  eval/                detection benchmark (make_fixtures.py, run.js)
```
