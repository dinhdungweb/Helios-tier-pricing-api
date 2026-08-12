const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ALLOWED_ORIGINS = 'https://helios.vn';
process.env.RESEND_API_KEY = 're_test';
process.env.PARTNERSHIP_FROM_EMAIL = 'HELIOS <partnership@helios.vn>';
process.env.SHOPIFY_SHOP = 'helios-test.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_test';

const handler = require('../api/partnership');

test('sends to the recipient read from the published Partnership section', async () => {
  const originalFetch = global.fetch;
  let sentPayload;
  global.fetch = async (url, options) => {
    if (String(url).includes('myshopify.com')) {
      return shopifyThemeResponse('marketing@helios.vn');
    }
    sentPayload = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => '' };
  };

  try {
    const response = createResponse();
    await handler(createRequest({ recipient_email: 'marketing@helios.vn' }), response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { success: true });
    assert.deepEqual(sentPayload.to, ['marketing@helios.vn']);
    assert.equal(sentPayload.reply_to, 'partner@example.com');
  } finally {
    global.fetch = originalFetch;
  }
});

test('ignores a forged recipient and uses the published section value', async () => {
  const originalFetch = global.fetch;
  let sentPayload;
  global.fetch = async (url, options) => {
    if (String(url).includes('myshopify.com')) {
      return shopifyThemeResponse('partnership@helios.vn');
    }
    sentPayload = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => '' };
  };

  try {
    const response = createResponse();
    await handler(createRequest({ recipient_email: 'attacker@example.com' }), response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(sentPayload.to, ['partnership@helios.vn']);
  } finally {
    global.fetch = originalFetch;
  }
});

function createRequest(overrides = {}) {
  return {
    method: 'POST',
    headers: {
      origin: 'https://helios.vn',
      'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 200) + 1}`
    },
    body: {
      email: 'partner@example.com',
      reason: 'Phù hợp với định hướng thương hiệu.',
      goal: 'Mở rộng hệ thống phân phối.',
      expected_support: 'Nội dung và đào tạo.',
      document_links: 'https://example.com/deck',
      page_url: 'https://helios.vn/pages/partnership',
      section_id: 'partnership_contact_form_Fiyrqp',
      template_file: 'templates/page.helios-partnership.json',
      ...overrides
    }
  };
}

function shopifyThemeResponse(recipientEmail) {
  const template = {
    sections: {
      partnership_contact_form_Fiyrqp: {
        type: 'partnership-contact-form',
        settings: { recipient_email: recipientEmail }
      }
    }
  };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        themes: {
          nodes: [{
            files: {
              nodes: [{
                filename: 'templates/page.helios-partnership.json',
                body: { content: JSON.stringify(template) }
              }],
              userErrors: []
            }
          }]
        }
      }
    })
  };
}

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    }
  };
}
