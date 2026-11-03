const catalogs = {
  vi: require('../locales/vi.json'),
  en: require('../locales/en.json')
};

const messageKeys = new Map();
for (const catalog of Object.values(catalogs)) {
  for (const [key, value] of Object.entries(catalog)) messageKeys.set(value, key);
}

function getLocale(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const language = body?.locale || req.query?.locale;
  // Preserve Vietnamese for existing API clients that do not send a locale.
  return !language || /^vi(?:-|$)/i.test(String(language)) ? 'vi' : 'en';
}

function message(key, values = {}, locale = 'vi') {
  const catalog = catalogs[locale] || catalogs.en;
  return String(catalog[key] || catalogs.en[key] || '').replace(/\{\{\s*(\w+)\s*\}\}/g,
    (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}

// Only localize public error fields; stored rewards, names and submission data stay intact.
function localizeResponse(req, res) {
  const locale = getLocale(req);
  const json = res.json;
  res.json = function (payload) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      payload = { ...payload };
      for (const field of ['message', 'error']) {
        const key = messageKeys.get(payload[field]);
        if (key) payload[field] = message(key, {}, locale);
      }
    }
    return json.call(this, payload);
  };
}

module.exports = { getLocale, message, localizeResponse };
