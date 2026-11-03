const test = require('node:test');
const assert = require('node:assert/strict');
const { getLocale, message, localizeResponse } = require('../lib/localization');

test('API selects storefront locale and keeps existing clients in Vietnamese', () => {
  assert.equal(getLocale({}), 'vi');
  assert.equal(getLocale({ body: { locale: 'vi-VN' } }), 'vi');
  assert.equal(getLocale({ body: '{"locale":"en-GB"}' }), 'en');
  assert.equal(getLocale({ query: { locale: 'fr' } }), 'en');
  assert.equal(getLocale({ body: 'invalid JSON' }), 'vi');
});

test('public API errors are translated without changing stored data or status', () => {
  for (const locale of ['vi', 'en']) {
    const response = { statusCode: 409, json(payload) { this.body = payload; return this; } };
    localizeResponse({ body: { locale } }, response);
    response.json({ error: message('no_turns'), history: [{ title: 'Thẻ khách đã lưu' }] });
    assert.equal(response.body.error, message('no_turns', {}, locale));
    assert.equal(response.body.history[0].title, 'Thẻ khách đã lưu');
    assert.equal(response.statusCode, 409);
  }
});

test('Partnership endpoint returns its public error in the requested language', async () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const handler = require('../api/partnership');
    for (const locale of ['en', 'vi']) {
      const response = {
        setHeader() {},
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
      };
      await handler({ method: 'POST', headers: {}, body: { locale } }, response);
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.message, message('not_configured', {}, locale));
    }
  } finally {
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;
  }
});

