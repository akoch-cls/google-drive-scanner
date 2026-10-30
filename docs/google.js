/**
 * ScannerAPI: everything that talks to Google.
 *
 *  - Sign-in with Google Identity Services (OAuth token model, no server)
 *  - Drive: browse/search/create folders, upload the PDF
 *  - Classroom: list classes and assignments, attach + turn in, teacher tools
 *  - buildPdf: wraps the finished JPEG pages in a PDF
 *
 * Every call runs in the browser with the signed-in user's own access token,
 * so files go to their own Drive.
 */
const ScannerAPI = (() => {
  'use strict';

  const CONFIG = window.SCANNER_CONFIG || {};
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const CLASSROOM = 'https://classroom.googleapis.com/v1';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const CLASSROOM_FOLDER_NAME = 'Scanned Assignments';
  const SHARED_DRIVES = 'shared';
  const MAX_PAGES = 60;

  const SCOPES = [
    'openid',
    'email',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.me'
  ];
  // Only requested when a teacher creates an assignment.
  const TEACHER_SCOPES = ['https://www.googleapis.com/auth/classroom.coursework.students'];

  let token = loadToken();     // { access_token, expires_at, scope }
  let client = null;
  let email = token && token.email || '';
  let rootId = null;
  const listeners = [];

  // ---------------------------------------------------------------------------
  // Sign-in
  // ---------------------------------------------------------------------------

  function isConfigured() {
    // Real client IDs look like 123456789012-abc123.apps.googleusercontent.com
    return /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(String(CONFIG.clientId || '').trim());
  }

  function loadToken() {
    try {
      const t = JSON.parse(sessionStorage.getItem('scanner.token'));
      return t && t.expires_at > Date.now() + 60000 ? t : null;
    } catch (err) {
      return null;
    }
  }

  function saveToken(t) {
    token = t;
    try {
      if (t) sessionStorage.setItem('scanner.token', JSON.stringify(t));
      else sessionStorage.removeItem('scanner.token');
    } catch (err) { /* storage unavailable */ }
    listeners.forEach(fn => fn(isSignedIn()));
  }

  function hasScopes(scopes) {
    const granted = (token && token.scope || '').split(' ');
    return scopes.every(s => s === 'openid' || s === 'email' || granted.includes(s));
  }

  function isSignedIn(minSeconds = 0) {
    return !!token && token.expires_at > Date.now() + minSeconds * 1000;
  }

  function onAuthChange(fn) {
    listeners.push(fn);
  }

  /**
   * Makes sure there's a valid token with the given scopes, showing Google's
   * sign-in pop-up if needed. Browsers only allow that pop-up during a click,
   * so call this first thing in a click handler, before any `await`.
   */
  function ensureSignedIn(extraScopes = []) {
    const needed = SCOPES.concat(extraScopes);
    if (isSignedIn(300) && hasScopes(needed)) return Promise.resolve(email);
    if (!isConfigured()) {
      const err = new Error('This copy of Doc Scanner is not set up yet: add a Google OAuth client ID to docs/config.js (see the README).');
      err.code = 'not_configured';
      return Promise.reject(err);
    }
    const gis = window.google && google.accounts && google.accounts.oauth2;
    if (!gis) return Promise.reject(new Error("Google sign-in is still loading (or is blocked by a filter). Try again in a moment."));

    return new Promise((resolve, reject) => {
      client = client || gis.initTokenClient({
        client_id: CONFIG.clientId.trim(),
        scope: SCOPES.join(' '),
        include_granted_scopes: true,
        callback: () => {}
      });
      client.callback = async resp => {
        if (resp.error) {
          reject(new Error(resp.error_description || 'Google sign-in failed (' + resp.error + ').'));
          return;
        }
        const t = {
          access_token: resp.access_token,
          scope: resp.scope || '',
          expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000
        };
        token = t;
        if (!hasScopes(needed)) {
          saveToken(null);
          reject(new Error('Please tick all the permission boxes on the Google screen so the scanner can save to Drive and Classroom.'));
          return;
        }
        try {
          const me = await request('https://www.googleapis.com/oauth2/v3/userinfo');
          email = me.email || '';
        } catch (err) { /* email is only for display */ }
        t.email = email;
        saveToken(t);
        resolve(email);
      };
      client.error_callback = err => {
        reject(new Error(err && err.type === 'popup_closed' ? 'Sign-in was cancelled.'
          : err && err.type === 'popup_failed_to_open' ? 'Your browser blocked the Google sign-in pop-up. Allow pop-ups for this site and try again.'
            : 'Google sign-in failed.'));
      };
      client.requestAccessToken({ scope: needed.join(' '), hint: email || undefined, prompt: '' });
    });
  }

  function signOut() {
    const t = token;
    saveToken(null);
    email = '';
    if (t && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(t.access_token, () => {});
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  function authError() {
    const err = new Error('Your Google sign-in expired. Click the button again to sign back in.');
    err.code = 'auth';
    return err;
  }

  function withQuery(url, query) {
    if (!query) return url;
    const params = new URLSearchParams();
    Object.keys(query).forEach(k => {
      const v = query[k];
      if (v === undefined || v === null || v === '') return;
      [].concat(v).forEach(x => params.append(k, x));
    });
    const qs = params.toString();
    return qs ? url + (url.includes('?') ? '&' : '?') + qs : url;
  }

  async function request(url, { method = 'GET', query, body } = {}) {
    if (!token) throw authError();
    const headers = { Authorization: 'Bearer ' + token.access_token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(withQuery(url, query), {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 401) {
      saveToken(null);
      throw authError();
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (err) { data = { raw: text }; }
    if (!res.ok) {
      const e = data.error || {};
      const err = new Error(e.message || res.statusText || 'Request failed');
      err.status = e.status;
      err.httpStatus = res.status;
      throw err;
    }
    return data;
  }

  /** Follows nextPageToken until `limit` items have been collected. */
  async function listAll(url, query, key, limit) {
    let items = [];
    let pageToken;
    do {
      const res = await request(url, { query: Object.assign({}, query, { pageToken }) });
      items = items.concat(res[key] || []);
      pageToken = res.nextPageToken;
    } while (pageToken && items.length < limit);
    return items;
  }

  // ---------------------------------------------------------------------------
  // Drive
  // ---------------------------------------------------------------------------

  const ALL_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true };
  const quote = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

  async function getRootId() {
    if (!rootId) rootId = (await request(DRIVE + '/files/root', { query: { fields: 'id' } })).id;
    return rootId;
  }

  async function getFolderMeta(id) {
    return request(DRIVE + '/files/' + encodeURIComponent(id), {
      query: { fields: 'id,name,parents,driveId,mimeType,trashed', supportsAllDrives: true }
    });
  }

  /** Breadcrumb trail from My Drive (or a shared drive) down to the folder. */
  async function getPath(id) {
    const root = await getRootId();
    const path = [];
    let current = id === 'root' ? root : id;
    for (let depth = 0; current && depth < 15; depth++) {
      if (current === root) {
        path.unshift({ id: 'root', name: 'My Drive' });
        break;
      }
      const f = await getFolderMeta(current);
      if (f.driveId && f.id === f.driveId) {
        const drive = await request(DRIVE + '/drives/' + encodeURIComponent(f.driveId), { query: { fields: 'id,name' } });
        path.unshift({ id: drive.id, name: drive.name });
        path.unshift({ id: SHARED_DRIVES, name: 'Shared drives' });
        break;
      }
      path.unshift({ id: f.id, name: f.name });
      current = f.parents && f.parents[0];
    }
    return path;
  }

  async function listFolder(id) {
    id = id || 'root';
    if (id === SHARED_DRIVES) {
      const drives = await listAll(DRIVE + '/drives', { pageSize: 100, fields: 'nextPageToken,drives(id,name)' }, 'drives', 300);
      return {
        id, name: 'Shared drives', path: [{ id, name: 'Shared drives' }], selectable: false,
        children: drives.map(d => ({ id: d.id, name: d.name }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      };
    }
    const [path, files] = await Promise.all([
      getPath(id),
      listAll(DRIVE + '/files', Object.assign({
        q: quote(id) + " in parents and mimeType = '" + FOLDER_MIME + "' and trashed = false",
        fields: 'nextPageToken,files(id,name)',
        orderBy: 'name_natural',
        pageSize: 300
      }, ALL_DRIVES), 'files', 300)
    ]);
    const children = files.map(f => ({ id: f.id, name: f.name }));
    if (id === 'root') children.unshift({ id: SHARED_DRIVES, name: 'Shared drives', special: true });
    return { id, name: path[path.length - 1].name, path, selectable: true, children };
  }

  async function searchFolders(text) {
    text = String(text || '').trim();
    if (!text) return [];
    const res = await request(DRIVE + '/files', {
      query: Object.assign({
        q: 'name contains ' + quote(text) + " and mimeType = '" + FOLDER_MIME + "' and trashed = false",
        fields: 'files(id,name,parents)',
        corpora: 'allDrives',
        pageSize: 25
      }, ALL_DRIVES)
    });
    const files = res.files || [];
    const root = await getRootId();
    const parentNames = {};
    await Promise.all([...new Set(files.map(f => f.parents && f.parents[0]).filter(Boolean))].slice(0, 15).map(async pid => {
      if (pid === root) { parentNames[pid] = 'My Drive'; return; }
      try { parentNames[pid] = (await getFolderMeta(pid)).name; } catch (err) { /* no access */ }
    }));
    return files.map(f => ({ id: f.id, name: f.name, parent: parentNames[f.parents && f.parents[0]] || '' }));
  }

  async function createFolder(parentId, name) {
    name = cleanName(name);
    if (!name) throw new Error('Please enter a folder name.');
    if (parentId === SHARED_DRIVES) throw new Error('Open a shared drive first, then create the folder inside it.');
    const f = await request(DRIVE + '/files', {
      method: 'POST',
      query: { supportsAllDrives: true, fields: 'id,name' },
      body: { name, mimeType: FOLDER_MIME, parents: [parentId || 'root'] }
    });
    return { id: f.id, name: f.name, path: await getPath(f.id) };
  }

  async function findOrCreateFolder(name) {
    const res = await request(DRIVE + '/files', {
      query: {
        q: "'root' in parents and name = " + quote(name) + " and mimeType = '" + FOLDER_MIME + "' and trashed = false",
        fields: 'files(id,name)', pageSize: 1
      }
    });
    if (res.files && res.files[0]) return res.files[0];
    return request(DRIVE + '/files', {
      method: 'POST', query: { fields: 'id,name' }, body: { name, mimeType: FOLDER_MIME, parents: ['root'] }
    });
  }

  /** Multipart upload with progress (XHR, since fetch can't report upload progress). */
  function uploadFile(blob, metadata, onProgress) {
    return new Promise((resolve, reject) => {
      if (!token) { reject(authError()); return; }
      const boundary = 'scan' + Math.random().toString(36).slice(2);
      const body = new Blob([
        '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) +
        '\r\n--' + boundary + '\r\nContent-Type: ' + blob.type + '\r\n\r\n',
        blob,
        '\r\n--' + boundary + '--'
      ]);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', UPLOAD + '?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink');
      xhr.setRequestHeader('Authorization', 'Bearer ' + token.access_token);
      xhr.setRequestHeader('Content-Type', 'multipart/related; boundary=' + boundary);
      xhr.upload.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onerror = () => reject(new Error('The upload failed. Check your internet connection and try again.'));
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch (err) { /* ignore */ }
        if (xhr.status === 401) { saveToken(null); reject(authError()); return; }
        if (xhr.status >= 300) {
          reject(new Error(data.error && data.error.message || 'Upload failed (' + xhr.status + ').'));
          return;
        }
        resolve(data);
      };
      xhr.send(body);
    });
  }

  async function uploadPdf(folderId, name, pages, onProgress) {
    name = cleanName(name) || 'Scan';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    const pdf = buildPdf(decodePages(pages));
    const f = await uploadFile(pdf, { name, mimeType: 'application/pdf', parents: [folderId || 'root'] }, onProgress);
    return { id: f.id, name: f.name, url: f.webViewLink || 'https://drive.google.com/file/d/' + f.id + '/view' };
  }

  /**
   * @param {{name: string, folderId: string, pages: Array<{data: string, width: number, height: number}>, onProgress?: Function}} req
   */
  async function saveScan(req) {
    const folderId = req.folderId || 'root';
    if (folderId === SHARED_DRIVES) throw new Error('Pick a shared drive or a folder inside one.');
    let path;
    try {
      path = await getPath(folderId);
    } catch (err) {
      if (err.code === 'auth') throw err;
      const e = new Error("That folder can't be found any more. Please pick another one.");
      e.code = 'folder_missing';
      throw e;
    }
    const file = await uploadPdf(folderId, req.name, req.pages, req.onProgress);
    const name = path[path.length - 1].name;
    return {
      file,
      folder: {
        id: folderId, name,
        path: path.map(p => p.name).join(' › '),
        url: folderId === 'root' ? 'https://drive.google.com/drive/my-drive' : 'https://drive.google.com/drive/folders/' + folderId
      }
    };
  }

  // ---------------------------------------------------------------------------
  // PDF
  // ---------------------------------------------------------------------------

  function decodePages(pages) {
    if (!pages || !pages.length) throw new Error('There are no pages to save.');
    if (pages.length > MAX_PAGES) throw new Error('Please save at most ' + MAX_PAGES + ' pages at a time.');
    return pages.map((p, i) => {
      const bin = atob(p.data);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Page ' + (i + 1) + ' is not a valid image.');
      return { bytes, width: Math.round(p.width), height: Math.round(p.height) };
    });
  }

  /**
   * One JPEG per page, embedded as-is (DCTDecode), so nothing is re-encoded.
   * Pages are sized so the long edge is 11in (Letter), keeping the scan's shape.
   */
  function buildPdf(pages) {
    const parts = [];
    const offsets = [];
    let length = 0;
    const str = s => { parts.push(s); length += s.length; }; // ASCII only
    const bin = b => { parts.push(b); length += b.byteLength; };
    const beginObj = n => { offsets[n] = length; str(n + ' 0 obj\n'); };
    const round2 = n => Math.round(n * 100) / 100;

    const objCount = 2 + pages.length * 3;
    str('%PDF-1.4\n');
    bin(new Uint8Array([37, 226, 227, 207, 211, 10])); // binary marker comment

    beginObj(1);
    str('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    beginObj(2);
    str('<< /Type /Pages /Kids [' + pages.map((_, i) => (3 + i * 3) + ' 0 R').join(' ') +
      '] /Count ' + pages.length + ' >>\nendobj\n');

    pages.forEach((p, i) => {
      const pageObj = 3 + i * 3, imgObj = pageObj + 1, contentObj = pageObj + 2;
      const scale = 792 / Math.max(p.width, p.height);
      const w = round2(p.width * scale), h = round2(p.height * scale);

      beginObj(pageObj);
      str('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + ']' +
        ' /Resources << /XObject << /Im0 ' + imgObj + ' 0 R >> >>' +
        ' /Contents ' + contentObj + ' 0 R >>\nendobj\n');

      beginObj(imgObj);
      str('<< /Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
        p.bytes.byteLength + ' >>\nstream\n');
      bin(p.bytes);
      str('\nendstream\nendobj\n');

      const content = 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im0 Do Q';
      beginObj(contentObj);
      str('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
    });

    const xrefOffset = length;
    let xref = 'xref\n0 ' + (objCount + 1) + '\n0000000000 65535 f \n';
    for (let n = 1; n <= objCount; n++) xref += ('0000000000' + offsets[n]).slice(-10) + ' 00000 n \n';
    str(xref);
    str('trailer\n<< /Size ' + (objCount + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n');
    return new Blob(parts, { type: 'application/pdf' });
  }

  // ---------------------------------------------------------------------------
  // Classroom
  // ---------------------------------------------------------------------------

  async function listCourses(role) {
    const courses = await listAll(CLASSROOM + '/courses',
      { [role]: 'me', courseStates: 'ACTIVE', pageSize: 100 }, 'courses', 300);
    return courses.map(c => ({ id: c.id, name: c.name, section: c.section || '' }));
  }

  const getStudentCourses = () => listCourses('studentId');
  const getTeachingCourses = () => listCourses('teacherId');

  function listCourseWork(courseId, limit) {
    return listAll(CLASSROOM + '/courses/' + encodeURIComponent(courseId) + '/courseWork',
      { courseWorkStates: 'PUBLISHED', pageSize: 100 }, 'courseWork', limit);
  }

  function dueIso(date, time) {
    if (!date) return null;
    time = time || { hours: 23, minutes: 59 };
    return new Date(Date.UTC(date.year, date.month - 1, date.day, time.hours || 0, time.minutes || 0)).toISOString();
  }

  /** Assignments in a course, merged with the student's own submission for each. */
  async function getAssignments(courseId) {
    const [work, subs] = await Promise.all([
      listCourseWork(courseId, 300),
      listAll(CLASSROOM + '/courses/' + encodeURIComponent(courseId) + '/courseWork/-/studentSubmissions',
        { userId: 'me', pageSize: 100 }, 'studentSubmissions', 300)
    ]);
    const subByWork = {};
    subs.forEach(s => { subByWork[s.courseWorkId] = s; });

    const items = work.filter(w => w.workType === 'ASSIGNMENT').map(w => {
      const s = subByWork[w.id] || {};
      return {
        id: w.id,
        courseId,
        title: w.title,
        due: dueIso(w.dueDate, w.dueTime),
        link: s.alternateLink || w.alternateLink,
        oneClick: !!w.associatedWithDeveloper,
        submissionId: s.id || null,
        state: s.state || 'NEW',
        late: !!s.late
      };
    });

    const done = { TURNED_IN: 1, RETURNED: 1 };
    items.sort((a, b) => {
      const da = done[a.state] ? 1 : 0, db = done[b.state] ? 1 : 0;
      if (da !== db) return da - db;
      if (!da) { // open work: soonest due first, no due date last
        if (a.due && b.due) return a.due < b.due ? -1 : 1;
        if (a.due || b.due) return a.due ? -1 : 1;
      }
      return 0; // keep Classroom's newest-first order
    });
    return items;
  }

  function classroomError(err) {
    const msg = String(err && err.message || err);
    if (/ProjectPermissionDenied|Developer Console project/i.test(msg) || (err && err.httpStatus === 403)) {
      return 'Classroom only lets apps attach files to assignments they created, so please attach this file in Classroom.';
    }
    if (err && err.status === 'FAILED_PRECONDITION') {
      return 'This assignment is already turned in. Unsubmit it in Classroom first, then attach the file.';
    }
    return msg;
  }

  /**
   * Saves the scan to Drive, attaches it to the student's submission and turns
   * it in. Classroom only allows this for assignments created by the same
   * Google Cloud project ("one-click" assignments). For any other assignment the
   * file is saved and the student finishes in Classroom.
   */
  async function submitToClassroom(req) {
    const folder = await findOrCreateFolder(CLASSROOM_FOLDER_NAME);
    const file = await uploadPdf(folder.id, req.name, req.pages, req.onProgress);
    const result = { file, link: req.link, status: 'manual', message: '' };
    if (!req.submissionId) {
      result.message = "Classroom didn't return a submission for you on this assignment.";
      return result;
    }
    const base = CLASSROOM + '/courses/' + encodeURIComponent(req.courseId) + '/courseWork/' +
      encodeURIComponent(req.courseWorkId) + '/studentSubmissions/' + encodeURIComponent(req.submissionId);
    try {
      await request(base + ':modifyAttachments', {
        method: 'POST', body: { addAttachments: [{ driveFile: { id: file.id } }] }
      });
    } catch (err) {
      if (err.code === 'auth') throw err;
      result.message = classroomError(err);
      return result;
    }
    result.status = 'attached';
    if (req.turnIn) {
      try {
        await request(base + ':turnIn', { method: 'POST', body: {} });
        result.status = 'turnedIn';
      } catch (err) {
        result.message = classroomError(err);
      }
    }
    return result;
  }

  function appUrl() {
    return location.origin + location.pathname;
  }

  function scanLink(courseId, courseWorkId) {
    return appUrl() + '?course=' + encodeURIComponent(courseId) + '&assignment=' + encodeURIComponent(courseWorkId);
  }

  async function getCourseWorkForTeacher(courseId) {
    const work = await listCourseWork(courseId, 200);
    return work.filter(w => w.workType === 'ASSIGNMENT').map(w => ({
      id: w.id, title: w.title, oneClick: !!w.associatedWithDeveloper, scanLink: scanLink(courseId, w.id)
    }));
  }

  /**
   * Creates an assignment through this app so students get one-click turn in,
   * and puts the scanner link in the instructions.
   */
  async function createScanAssignment(req) {
    const title = String(req.title || '').trim();
    if (!title) throw new Error('Please give the assignment a title.');
    const work = { title, workType: 'ASSIGNMENT', state: 'PUBLISHED' };
    if (req.description) work.description = String(req.description);
    if (req.maxPoints) work.maxPoints = Number(req.maxPoints);
    if (req.dueIso) {
      const d = new Date(req.dueIso);
      if (isNaN(d)) throw new Error('The due date is not valid.');
      work.dueDate = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
      work.dueTime = { hours: d.getUTCHours(), minutes: d.getUTCMinutes() };
    }
    const base = CLASSROOM + '/courses/' + encodeURIComponent(req.courseId) + '/courseWork';
    const created = await request(base, { method: 'POST', body: work });
    const link = scanLink(req.courseId, created.id);
    await request(base + '/' + encodeURIComponent(created.id), {
      method: 'PATCH',
      query: { updateMask: 'description' },
      body: { description: (work.description ? work.description + '\n\n' : '') + 'Scan your work and turn it in here: ' + link }
    });
    return { id: created.id, title: created.title, link: created.alternateLink, scanLink: link };
  }

  function cleanName(name) {
    return String(name || '').replace(/[\u0000-\u001f\/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  return {
    TEACHER_SCOPES,
    isConfigured, isSignedIn, ensureSignedIn, signOut, onAuthChange,
    getEmail: () => email,
    listFolder, searchFolders, createFolder, saveScan,
    getStudentCourses, getAssignments, submitToClassroom,
    getTeachingCourses, getCourseWorkForTeacher, createScanAssignment,
    buildPdf
  };
})();
