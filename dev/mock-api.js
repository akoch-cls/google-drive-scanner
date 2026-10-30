/*
 * Stand-in for docs/google.js, so the UI can be tried locally without a Google
 * Cloud project. `node dev/serve.js --mock` serves it in place of google.js.
 * Nothing leaves your computer; saves are only recorded on window.__lastSave.
 */
const ScannerAPI = (() => {
  const folders = {
    root: { name: 'My Drive', parent: null },
    f1: { name: 'School', parent: 'root' },
    f2: { name: 'Biology', parent: 'f1' },
    f3: { name: 'History', parent: 'f1' },
    f4: { name: 'Receipts', parent: 'root' }
  };
  const path = id => {
    const out = [];
    for (let cur = id; cur; cur = folders[cur].parent) out.unshift({ id: cur, name: folders[cur].name });
    return out;
  };
  const soon = days => new Date(Date.now() + days * 864e5).toISOString();
  const assignments = {
    c1: [
      { id: 'w1', courseId: 'c1', title: 'Lab report: Osmosis', due: soon(2), link: 'https://classroom.google.com', oneClick: true, submissionId: 's1', state: 'CREATED', late: false },
      { id: 'w2', courseId: 'c1', title: 'Cell diagram worksheet', due: soon(-1), link: 'https://classroom.google.com', oneClick: false, submissionId: 's2', state: 'CREATED', late: true },
      { id: 'w3', courseId: 'c1', title: 'Reading notes ch. 3', due: null, link: 'https://classroom.google.com', oneClick: false, submissionId: 's3', state: 'TURNED_IN', late: false }
    ],
    c2: []
  };
  const listeners = [];
  let signedIn = false;
  const later = (fn, ms = 300) => new Promise((resolve, reject) => setTimeout(() => {
    try { resolve(fn()); } catch (err) { reject(err); }
  }, ms));
  const progress = async onProgress => {
    for (let i = 1; i <= 4; i++) { await later(() => {}, 100); onProgress && onProgress(i / 4); }
  };

  return {
    TEACHER_SCOPES: [],
    isConfigured: () => true,
    isSignedIn: () => signedIn,
    ensureSignedIn: () => {
      if (!signedIn) { signedIn = true; listeners.forEach(fn => fn(true)); }
      return Promise.resolve('student@example.org');
    },
    signOut: () => { signedIn = false; listeners.forEach(fn => fn(false)); },
    onAuthChange: fn => listeners.push(fn),
    getEmail: () => (signedIn ? 'student@example.org' : ''),
    listFolder: id => later(() => {
      id = id || 'root';
      const children = Object.keys(folders).filter(k => folders[k].parent === id).map(k => ({ id: k, name: folders[k].name }));
      return { id, name: folders[id].name, path: path(id), selectable: true, children };
    }),
    searchFolders: q => later(() => Object.keys(folders)
      .filter(k => k !== 'root' && folders[k].name.toLowerCase().includes(q.toLowerCase()))
      .map(k => ({ id: k, name: folders[k].name, parent: folders[folders[k].parent].name }))),
    createFolder: (parentId, name) => later(() => {
      const id = 'n' + Date.now();
      folders[id] = { name, parent: parentId || 'root' };
      return { id, name, path: path(id) };
    }),
    saveScan: async req => {
      window.__lastSave = req;
      await progress(req.onProgress);
      const id = req.folderId || 'root';
      const p = path(id);
      return {
        file: { id: 'file1', name: req.name + '.pdf', url: '#' },
        folder: { id, name: folders[id].name, path: p.map(x => x.name).join(' › '), url: '#' }
      };
    },
    getStudentCourses: () => later(() => [{ id: 'c1', name: 'Biology', section: 'Period 3' }, { id: 'c2', name: 'World History', section: '' }]),
    getAssignments: courseId => later(() => assignments[courseId] || []),
    submitToClassroom: async req => {
      window.__lastSubmit = req;
      await progress(req.onProgress);
      const a = assignments.c1.find(x => x.id === req.courseWorkId) || {};
      const status = a.oneClick ? (req.turnIn ? 'turnedIn' : 'attached') : 'manual';
      return { file: { id: 'file2', name: req.name + '.pdf', url: '#' }, link: req.link, status, message: '' };
    },
    getTeachingCourses: () => later(() => [{ id: 't1', name: 'Biology', section: 'Period 3' }]),
    getCourseWorkForTeacher: () => later(() => [{ id: 'w9', title: 'Homework 4', oneClick: false, scanLink: location.origin + '/?course=t1&assignment=w9' }]),
    createScanAssignment: req => later(() => ({ id: 'w10', title: req.title, link: 'https://classroom.google.com', scanLink: location.origin + '/?course=t1&assignment=w10' }))
  };
})();
