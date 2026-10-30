/* Stand-in for google.script.run so the UI can be previewed outside Apps Script. */
(() => {
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
  const recent = [{ id: 'f2', name: 'Biology', path: 'My Drive › School › Biology' }];
  const soon = days => new Date(Date.now() + days * 864e5).toISOString();
  const assignments = {
    c1: [
      { id: 'w1', courseId: 'c1', title: 'Lab report: Osmosis', due: soon(2), link: 'https://classroom.google.com', oneClick: true, submissionId: 's1', state: 'CREATED', late: false },
      { id: 'w2', courseId: 'c1', title: 'Cell diagram worksheet', due: soon(-1), link: 'https://classroom.google.com', oneClick: false, submissionId: 's2', state: 'CREATED', late: true },
      { id: 'w3', courseId: 'c1', title: 'Reading notes ch. 3', due: null, link: 'https://classroom.google.com', oneClick: false, submissionId: 's3', state: 'TURNED_IN', late: false }
    ],
    c2: []
  };

  const api = {
    getInitialData: () => ({ email: 'student@example.org', recentFolders: recent, root: { id: 'root', name: 'My Drive' }, appUrl: 'https://script.google.com/macros/s/EXAMPLE/exec' }),
    listFolder: id => {
      id = id || 'root';
      const children = Object.keys(folders).filter(k => folders[k].parent === id).map(k => ({ id: k, name: folders[k].name }));
      return { id, name: folders[id].name, path: path(id), children };
    },
    searchFolders: q => Object.keys(folders).filter(k => k !== 'root' && folders[k].name.toLowerCase().includes(q.toLowerCase()))
      .map(k => ({ id: k, name: folders[k].name, parent: folders[folders[k].parent].name })),
    createFolder: (parentId, name) => {
      const id = 'n' + Date.now();
      folders[id] = { name, parent: parentId || 'root' };
      return { id, name, path: path(id) };
    },
    saveScan: req => {
      window.__lastSave = req;
      const id = req.folderId || 'root';
      const p = path(id);
      const entry = { id, name: folders[id].name, path: p.map(x => x.name).join(' › ') };
      const list = [entry].concat(recent.filter(r => r.id !== id));
      return { file: { id: 'file1', name: req.name + '.pdf', url: '#' }, folder: { id, name: folders[id].name, url: '#' }, recentFolders: list };
    },
    getStudentCourses: () => [{ id: 'c1', name: 'Biology', section: 'Period 3' }, { id: 'c2', name: 'World History', section: '' }],
    getAssignments: courseId => assignments[courseId] || [],
    submitToClassroom: req => {
      window.__lastSubmit = req;
      const a = assignments.c1.find(x => x.id === req.courseWorkId) || {};
      const status = a.oneClick ? (req.turnIn ? 'turnedIn' : 'attached') : 'manual';
      return { file: { id: 'file2', name: req.name + '.pdf', url: '#' }, link: req.link, status, message: '' };
    },
    getTeachingCourses: () => [{ id: 't1', name: 'Biology', section: 'Period 3' }],
    getCourseWorkForTeacher: () => [{ id: 'w9', title: 'Homework 4', oneClick: false, scanLink: 'https://script.google.com/macros/s/EXAMPLE/exec?course=t1&assignment=w9' }],
    createScanAssignment: req => ({ id: 'w10', title: req.title, link: 'https://classroom.google.com', scanLink: 'https://script.google.com/macros/s/EXAMPLE/exec?course=t1&assignment=w10' })
  };

  function runner(success, failure) {
    return new Proxy({}, {
      get(_, prop) {
        if (prop === 'withSuccessHandler') return fn => runner(fn, failure);
        if (prop === 'withFailureHandler') return fn => runner(success, fn);
        return (...args) => setTimeout(() => {
          try {
            if (!api[prop]) throw new Error('Mock: no function ' + prop);
            const result = JSON.parse(JSON.stringify(api[prop](...args) ?? null));
            success && success(result);
          } catch (err) {
            failure && failure(err);
          }
        }, 300);
      }
    });
  }

  window.google = {
    script: {
      run: runner(null, null),
      url: { getLocation: cb => cb({ parameter: Object.fromEntries(new URLSearchParams(location.search)) }) }
    }
  };
})();
