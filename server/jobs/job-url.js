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

module.exports = { pathSegments, isAbortJobUrl, isJobEventsUrl, getJobIdFromUrl };
