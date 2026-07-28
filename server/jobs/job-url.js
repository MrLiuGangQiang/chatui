function pathSegments(url = '') {
  return String(url || '').split('?')[0].split('/').filter(Boolean);
}

function isAbortJobUrl(url = '') {
  return pathSegments(url).at(-1) === 'abort';
}

function isJobEventsUrl(url = '') {
  return pathSegments(url).at(-1) === 'events';
}

function getJobIdFromUrl(reqOrUrl) {
  const url = typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl?.url;
  const segments = pathSegments(url);
  const tail = segments.at(-1);
  const raw = tail === 'events' || tail === 'abort' ? segments.at(-2) || '' : tail || '';
  try { return decodeURIComponent(raw); }
  catch { return ''; }
}

function parseJobRoute(url = '', basePath = '') {
  let pathname;
  try { pathname = new URL(String(url || ''), 'http://chatui.local').pathname; }
  catch { return { matched: false, valid: false, id: '', action: '' }; }
  if (pathname === basePath) return { matched: true, valid: true, id: '', action: 'start' };
  if (!pathname.startsWith(`${basePath}/`)) return { matched: false, valid: false, id: '', action: '' };
  const tail = pathname.slice(basePath.length + 1).split('/');
  if (tail.length < 1 || tail.length > 2 || !tail[0]) return { matched: true, valid: false, id: '', action: '' };
  let id;
  try { id = decodeURIComponent(tail[0]); }
  catch { return { matched: true, valid: false, id: '', action: '' }; }
  if (!id || id.length > 128 || /[\\/\u0000-\u001f\u007f]/.test(id)) {
    return { matched: true, valid: false, id: '', action: '' };
  }
  const action = tail[1] || 'job';
  if (!['job', 'abort', 'events'].includes(action)) return { matched: true, valid: false, id: '', action: '' };
  return { matched: true, valid: true, id, action };
}

module.exports = { pathSegments, isAbortJobUrl, isJobEventsUrl, getJobIdFromUrl, parseJobRoute };
