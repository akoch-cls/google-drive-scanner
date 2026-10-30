/**
 * Doc Scanner — Google Apps Script web app.
 *
 * The browser does all of the camera work (edge detection, perspective
 * correction, focus detection, image clean-up) and sends finished JPEG pages
 * here. This file turns them into a PDF, saves it to Drive, and optionally
 * attaches it to a Google Classroom assignment.
 */

var RECENT_FOLDERS_KEY = 'recentFolders';
var MAX_RECENT_FOLDERS = 6;
var CLASSROOM_FOLDER_NAME = 'Scanned Assignments';
var MAX_PAGES = 60;

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Doc Scanner')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Inlines another HTML file from the project (used by Index.html). */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Everything the page needs on first load, in one round trip. */
function getInitialData() {
  return {
    email: Session.getActiveUser().getEmail(),
    recentFolders: getRecentFolders_(),
    root: { id: DriveApp.getRootFolder().getId(), name: 'My Drive' },
    appUrl: ScriptApp.getService().getUrl()
  };
}

// ---------------------------------------------------------------------------
// Drive folders
// ---------------------------------------------------------------------------

/** Lists the sub-folders of a folder (My Drive when no id is given). */
function listFolder(folderId) {
  var folder = folderId ? getFolder_(folderId) : DriveApp.getRootFolder();
  var children = [];
  var it = folder.searchFolders('trashed = false');
  while (it.hasNext() && children.length < 300) {
    var f = it.next();
    children.push({ id: f.getId(), name: f.getName() });
  }
  children.sort(function (a, b) {
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  var path = getPath_(folder);
  return {
    id: folder.getId(),
    name: path[path.length - 1].name,
    path: path,
    children: children
  };
}

/** Finds folders anywhere in Drive whose name contains the query. */
function searchFolders(query) {
  query = String(query || '').trim();
  if (!query) return [];
  var safe = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  var it = DriveApp.searchFolders("title contains '" + safe + "' and trashed = false");
  var results = [];
  while (it.hasNext() && results.length < 25) {
    var f = it.next();
    var parents = f.getParents();
    results.push({
      id: f.getId(),
      name: f.getName(),
      parent: parents.hasNext() ? displayName_(parents.next()) : ''
    });
  }
  return results;
}

function createFolder(parentId, name) {
  name = cleanName_(name);
  if (!name) throw new Error('Please enter a folder name.');
  var parent = parentId ? getFolder_(parentId) : DriveApp.getRootFolder();
  var folder = parent.createFolder(name);
  return { id: folder.getId(), name: folder.getName(), path: getPath_(folder) };
}

// ---------------------------------------------------------------------------
// Saving scans
// ---------------------------------------------------------------------------

/**
 * Saves the scanned pages as a PDF.
 * @param {{name: string, folderId: string, pages: Array<{data: string, width: number, height: number}>}} req
 */
function saveScan(req) {
  var folder;
  try {
    folder = req.folderId ? getFolder_(req.folderId) : DriveApp.getRootFolder();
  } catch (err) {
    forgetFolder_(req.folderId);
    throw new Error("That folder can't be found any more. Please pick another one.");
  }
  var file = createPdfFile_(folder, req.name, req.pages);
  return {
    file: fileInfo_(file),
    folder: { id: folder.getId(), name: displayName_(folder), url: folder.getUrl() },
    recentFolders: rememberFolder_(folder)
  };
}

function createPdfFile_(folder, name, pages) {
  name = cleanName_(name) || 'Scan';
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  var blob = buildPdf_(decodePages_(pages), name);
  return folder.createFile(blob);
}

function decodePages_(pages) {
  if (!pages || !pages.length) throw new Error('There are no pages to save.');
  if (pages.length > MAX_PAGES) throw new Error('Please save at most ' + MAX_PAGES + ' pages at a time.');
  return pages.map(function (p, i) {
    var bytes = Utilities.base64Decode(p.data);
    // Every JPEG starts with FF D8 (-1, -40 as signed Java bytes).
    if (bytes.length < 4 || bytes[0] !== -1 || bytes[1] !== -40) {
      throw new Error('Page ' + (i + 1) + ' is not a valid image.');
    }
    var w = Math.round(Number(p.width)), h = Math.round(Number(p.height));
    if (!(w > 0 && h > 0)) throw new Error('Page ' + (i + 1) + ' is missing its size.');
    return { bytes: bytes, width: w, height: h };
  });
}

/**
 * Builds a PDF with one JPEG per page. JPEGs can be embedded in a PDF as-is
 * (DCTDecode), so no image re-encoding happens on the server.
 * Pages are sized so the long edge is 11in (Letter), keeping the scan's shape.
 */
function buildPdf_(pages, fileName) {
  var chunks = [];
  var length = 0;
  var offsets = []; // byte offset of each object, index = object number

  function str(s) {
    var b = Utilities.newBlob(s).getBytes();
    chunks.push(b);
    length += b.length;
  }
  function bytes(b) {
    chunks.push(b);
    length += b.length;
  }
  function beginObj(n) {
    offsets[n] = length;
    str(n + ' 0 obj\n');
  }

  var objCount = 2 + pages.length * 3;
  str('%PDF-1.4\n');
  bytes([37, -30, -29, -49, -45, 10]); // binary marker comment: %âãÏÓ

  beginObj(1);
  str('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  var kids = pages.map(function (_, i) { return (3 + i * 3) + ' 0 R'; });
  beginObj(2);
  str('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>\nendobj\n');

  pages.forEach(function (p, i) {
    var pageObj = 3 + i * 3, imgObj = pageObj + 1, contentObj = pageObj + 2;
    var scale = 792 / Math.max(p.width, p.height);
    var w = round2_(p.width * scale), h = round2_(p.height * scale);

    beginObj(pageObj);
    str('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + ']' +
        ' /Resources << /XObject << /Im0 ' + imgObj + ' 0 R >> >>' +
        ' /Contents ' + contentObj + ' 0 R >>\nendobj\n');

    beginObj(imgObj);
    str('<< /Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
        p.bytes.length + ' >>\nstream\n');
    bytes(p.bytes);
    str('\nendstream\nendobj\n');

    var content = 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im0 Do Q';
    beginObj(contentObj);
    str('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
  });

  var xrefOffset = length;
  var xref = 'xref\n0 ' + (objCount + 1) + '\n0000000000 65535 f \n';
  for (var n = 1; n <= objCount; n++) {
    xref += ('0000000000' + offsets[n]).slice(-10) + ' 00000 n \n';
  }
  str(xref);
  str('trailer\n<< /Size ' + (objCount + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n');

  return Utilities.newBlob([].concat.apply([], chunks), 'application/pdf', fileName);
}

// ---------------------------------------------------------------------------
// Google Classroom — students
// ---------------------------------------------------------------------------

function getStudentCourses() {
  return listCourses_({ studentId: 'me' });
}

/** Assignments in a course, merged with the student's own submission for each. */
function getAssignments(courseId) {
  var work = listAll_(function (token) {
    return Classroom.Courses.CourseWork.list(courseId, {
      courseWorkStates: ['PUBLISHED'], pageSize: 100, pageToken: token
    });
  }, 'courseWork', 300);
  var subs = listAll_(function (token) {
    return Classroom.Courses.CourseWork.StudentSubmissions.list(courseId, '-', {
      userId: 'me', pageSize: 100, pageToken: token
    });
  }, 'studentSubmissions', 300);

  var subByWork = {};
  subs.forEach(function (s) { subByWork[s.courseWorkId] = s; });

  var items = work
    .filter(function (w) { return w.workType === 'ASSIGNMENT'; })
    .map(function (w) {
      var s = subByWork[w.id] || {};
      return {
        id: w.id,
        courseId: courseId,
        title: w.title,
        due: dueIso_(w.dueDate, w.dueTime),
        link: s.alternateLink || w.alternateLink,
        oneClick: !!w.associatedWithDeveloper,
        submissionId: s.id || null,
        state: s.state || 'NEW',
        late: !!s.late
      };
    });

  var done = { TURNED_IN: 1, RETURNED: 1 };
  items.sort(function (a, b) {
    var da = done[a.state] ? 1 : 0, db = done[b.state] ? 1 : 0;
    if (da !== db) return da - db;
    if (!da) { // open work: soonest due first, no due date last
      if (a.due && b.due) return a.due < b.due ? -1 : 1;
      if (a.due || b.due) return a.due ? -1 : 1;
    }
    return 0; // keep Classroom's newest-first order
  });
  return items;
}

/**
 * Saves the scan to Drive, attaches it to the student's submission and turns
 * it in. Classroom only allows apps to attach files to assignments the same
 * app created ("one-click" assignments). For any other assignment the file is
 * saved and the student is sent to Classroom to attach it themselves.
 */
function submitToClassroom(req) {
  var folder = getOrCreateFolder_(DriveApp.getRootFolder(), CLASSROOM_FOLDER_NAME);
  var file = createPdfFile_(folder, req.name, req.pages);
  var result = { file: fileInfo_(file), link: req.link, status: 'manual', message: '' };

  if (!req.submissionId) {
    result.message = "Classroom didn't return a submission for you on this assignment.";
    return result;
  }

  try {
    Classroom.Courses.CourseWork.StudentSubmissions.modifyAttachments(
      { addAttachments: [{ driveFile: { id: file.getId() } }] },
      req.courseId, req.courseWorkId, req.submissionId);
  } catch (err) {
    result.message = classroomError_(err);
    return result;
  }

  result.status = 'attached';
  if (req.turnIn) {
    try {
      Classroom.Courses.CourseWork.StudentSubmissions.turnIn(
        {}, req.courseId, req.courseWorkId, req.submissionId);
      result.status = 'turnedIn';
    } catch (err) {
      result.message = classroomError_(err);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Google Classroom — teachers
// ---------------------------------------------------------------------------

function getTeachingCourses() {
  return listCourses_({ teacherId: 'me' });
}

function getCourseWorkForTeacher(courseId) {
  var appUrl = ScriptApp.getService().getUrl();
  return listAll_(function (token) {
    return Classroom.Courses.CourseWork.list(courseId, {
      courseWorkStates: ['PUBLISHED'], pageSize: 100, pageToken: token
    });
  }, 'courseWork', 200)
    .filter(function (w) { return w.workType === 'ASSIGNMENT'; })
    .map(function (w) {
      return {
        id: w.id,
        title: w.title,
        oneClick: !!w.associatedWithDeveloper,
        scanLink: scanLink_(appUrl, courseId, w.id)
      };
    });
}

/**
 * Creates an assignment through this app so students get one-click turn in,
 * and puts the scanner link in the instructions.
 * @param {{courseId: string, title: string, description: string, dueIso: string, maxPoints: number}} req
 */
function createScanAssignment(req) {
  var title = String(req.title || '').trim();
  if (!title) throw new Error('Please give the assignment a title.');

  var work = { title: title, workType: 'ASSIGNMENT', state: 'PUBLISHED' };
  if (req.description) work.description = String(req.description);
  if (req.maxPoints) work.maxPoints = Number(req.maxPoints);
  if (req.dueIso) {
    var d = new Date(req.dueIso);
    if (isNaN(d)) throw new Error('The due date is not valid.');
    work.dueDate = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    work.dueTime = { hours: d.getUTCHours(), minutes: d.getUTCMinutes() };
  }

  var created = Classroom.Courses.CourseWork.create(work, req.courseId);
  var link = scanLink_(ScriptApp.getService().getUrl(), req.courseId, created.id);
  var description = (work.description ? work.description + '\n\n' : '') +
      'Scan your work and turn it in here: ' + link;
  Classroom.Courses.CourseWork.patch({ description: description },
      req.courseId, created.id, { updateMask: 'description' });

  return { id: created.id, title: created.title, link: created.alternateLink, scanLink: link };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFolder_(id) {
  return DriveApp.getFolderById(id);
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) return f;
  }
  return parent.createFolder(name);
}

function displayName_(folder) {
  return folder.getId() === DriveApp.getRootFolder().getId() ? 'My Drive' : folder.getName();
}

/** Breadcrumb trail from My Drive (or the highest folder we can see) down to the folder. */
function getPath_(folder) {
  var rootId = DriveApp.getRootFolder().getId();
  var path = [];
  var current = folder;
  for (var depth = 0; current && depth < 15; depth++) {
    var id = current.getId();
    path.unshift({ id: id, name: id === rootId ? 'My Drive' : current.getName() });
    if (id === rootId) break;
    var parents = current.getParents();
    current = parents.hasNext() ? parents.next() : null;
  }
  return path;
}

function fileInfo_(file) {
  return { id: file.getId(), name: file.getName(), url: file.getUrl() };
}

function cleanName_(name) {
  return String(name || '').replace(/[\u0000-\u001f\/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function getRecentFolders_() {
  try {
    return JSON.parse(PropertiesService.getUserProperties().getProperty(RECENT_FOLDERS_KEY)) || [];
  } catch (err) {
    return [];
  }
}

function saveRecentFolders_(list) {
  PropertiesService.getUserProperties().setProperty(RECENT_FOLDERS_KEY, JSON.stringify(list));
  return list;
}

function rememberFolder_(folder) {
  var path = getPath_(folder);
  var entry = {
    id: folder.getId(),
    name: path[path.length - 1].name,
    path: path.map(function (p) { return p.name; }).join(' › ')
  };
  var list = getRecentFolders_().filter(function (f) { return f.id !== entry.id; });
  list.unshift(entry);
  return saveRecentFolders_(list.slice(0, MAX_RECENT_FOLDERS));
}

function forgetFolder_(id) {
  saveRecentFolders_(getRecentFolders_().filter(function (f) { return f.id !== id; }));
}

function listCourses_(filter) {
  filter.courseStates = ['ACTIVE'];
  return listAll_(function (token) {
    filter.pageToken = token;
    filter.pageSize = 100;
    return Classroom.Courses.list(filter);
  }, 'courses', 300).map(function (c) {
    return { id: c.id, name: c.name, section: c.section || '' };
  });
}

/** Follows nextPageToken until `limit` items have been collected. */
function listAll_(fetchPage, key, limit) {
  var items = [];
  var token;
  do {
    var res = fetchPage(token) || {};
    items = items.concat(res[key] || []);
    token = res.nextPageToken;
  } while (token && items.length < limit);
  return items;
}

function dueIso_(date, time) {
  if (!date) return null;
  time = time || { hours: 23, minutes: 59 };
  return new Date(Date.UTC(date.year, date.month - 1, date.day,
      time.hours || 0, time.minutes || 0)).toISOString();
}

function scanLink_(appUrl, courseId, courseWorkId) {
  return appUrl + '?course=' + encodeURIComponent(courseId) +
      '&assignment=' + encodeURIComponent(courseWorkId);
}

function classroomError_(err) {
  var msg = String(err && err.message || err);
  if (/ProjectPermissionDenied|Developer Console project/i.test(msg)) {
    return 'Classroom only lets apps attach files to assignments they created, so please attach this file in Classroom.';
  }
  if (/FAILED_PRECONDITION|state/i.test(msg)) {
    return 'This assignment is already turned in. Unsubmit it in Classroom first, then attach the file.';
  }
  return msg;
}
