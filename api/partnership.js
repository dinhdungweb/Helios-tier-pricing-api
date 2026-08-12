const DEFAULT_ALLOWED_ORIGINS =
  'https://helios.vn,https://www.helios.vn,https://heliosjewels-vn.myshopify.com';
const SHOPIFY_API_VERSION = '2026-07';
const SHOPIFY_SHOP = normalizeShopDomain(process.env.SHOPIFY_SHOP);
const SHOPIFY_ACCESS_TOKEN = String(process.env.SHOPIFY_ACCESS_TOKEN || '').trim();

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const requestLog = new Map();

module.exports = async (req, res) => {
  const origin = normalizeOrigin(req.headers && req.headers.origin);
  const allowedOrigins = parseList(process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
    .map(normalizeOrigin);

  setCorsHeaders(origin, allowedOrigins, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (isRateLimited(getClientIp(req))) {
    return res.status(429).json({
      error: 'Too many requests',
      message: 'Vui lòng thử lại sau ít phút.'
    });
  }

  const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();
  const fromEmail = String(process.env.PARTNERSHIP_FROM_EMAIL || '').trim();
  if (!resendApiKey || !fromEmail || !SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
    console.error('Partnership email environment variables are incomplete');
    return res.status(503).json({
      error: 'Service unavailable',
      message: 'Hệ thống nhận thông tin chưa được cấu hình.'
    });
  }

  const body = parseBody(req.body);

  // Honeypot: real visitors never fill this hidden field.
  if (cleanText(body.company_website, 200)) {
    return res.status(200).json({ success: true });
  }

  const templateFile = normalizeTemplateFilename(body.template_file);
  const sectionId = cleanText(body.section_id, 150);
  if (!templateFile || !sectionId) {
    return res.status(400).json({
      error: 'Invalid section',
      message: 'Không xác định được cấu hình section.'
    });
  }

  const submission = {
    email: normalizeEmail(body.email),
    reason: cleanText(body.reason, 5000),
    goal: cleanText(body.goal, 5000),
    expectedSupport: cleanText(body.expected_support, 5000),
    documentLinks: cleanText(body.document_links, 3000),
    pageUrl: cleanText(body.page_url, 1000)
  };

  const validationError = validateSubmission(submission);
  if (validationError) {
    return res.status(400).json({ error: 'Invalid submission', message: validationError });
  }

  try {
    const recipientEmail = await loadPublishedSectionRecipient(templateFile, sectionId);
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [recipientEmail],
        reply_to: submission.email,
        subject: `Đề xuất hợp tác HELIOS từ ${submission.email}`,
        text: buildEmailText(submission)
      })
    });

    if (!resendResponse.ok) {
      const resendError = await resendResponse.text();
      console.error('Resend partnership email failed:', resendResponse.status, resendError);
      return res.status(502).json({
        error: 'Email delivery failed',
        message: 'Chưa thể gửi thông tin. Vui lòng thử lại.'
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Partnership email error:', error);
    return res.status(500).json({
      error: 'Email delivery failed',
      message: error.publicMessage || 'Chưa thể gửi thông tin. Vui lòng thử lại.'
    });
  }
};

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'object') return body;
  try {
    return JSON.parse(body);
  } catch (_error) {
    return {};
  }
}

async function loadPublishedSectionRecipient(templateFile, sectionId) {
  const query = `
    query PublishedPartnershipTemplate($filename: String!) {
      themes(first: 1, roles: [MAIN]) {
        nodes {
          files(first: 1, filenames: [$filename]) {
            nodes {
              filename
              body {
                ... on OnlineStoreThemeFileBodyText {
                  content
                }
              }
            }
            userErrors {
              code
              filename
            }
          }
        }
      }
    }
  `;
  const data = await executeAdminGraphQL(query, { filename: templateFile });
  const theme = data.themes && Array.isArray(data.themes.nodes)
    ? data.themes.nodes[0]
    : null;
  const files = theme && theme.files;

  if (files && Array.isArray(files.userErrors) && files.userErrors.length > 0) {
    throw new Error('Shopify could not read the published page template');
  }

  const file = files && Array.isArray(files.nodes) ? files.nodes[0] : null;
  const content = file && file.body && file.body.content;
  if (!content) {
    throw new Error('Published page template was not found');
  }

  const template = parseShopifyJson(content);
  const configuredSection = template.sections && template.sections[sectionId];
  if (!configuredSection || configuredSection.type !== 'partnership-contact-form') {
    throw new Error('Partnership section was not found in the published template');
  }

  const recipientEmail = normalizeEmail(
    configuredSection.settings && configuredSection.settings.recipient_email
  );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    const error = new Error('Recipient email is missing from the published Partnership section');
    error.publicMessage = 'Vui lòng cấu hình Recipient email trong section Partnership.';
    throw error;
  }

  return recipientEmail;
}

async function executeAdminGraphQL(query, variables) {
  const response = await fetch(
    `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ query, variables })
    }
  );

  if (!response.ok) {
    throw new Error(`Shopify API returned ${response.status}`);
  }

  const result = await response.json();
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(result.errors.map(item => item.message).join('; '));
  }
  if (!result.data) {
    throw new Error('Shopify returned an invalid response');
  }
  return result.data;
}

function parseShopifyJson(content) {
  const withoutComments = String(content).replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(withoutComments);
}

function validateSubmission(submission) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submission.email)) {
    return 'Email liên hệ không hợp lệ.';
  }
  if (!submission.reason || !submission.goal || !submission.expectedSupport) {
    return 'Vui lòng điền đầy đủ các trường bắt buộc.';
  }
  return '';
}

function buildEmailText(submission) {
  return [
    'ĐỀ XUẤT HỢP TÁC HELIOS',
    '',
    `Email liên hệ: ${submission.email}`,
    '',
    'Vì sao quan tâm đến HELIOS:',
    submission.reason,
    '',
    'Mục tiêu trong 12–24 tháng:',
    submission.goal,
    '',
    'Hỗ trợ mong đợi từ HELIOS:',
    submission.expectedSupport,
    '',
    'Link tài liệu:',
    submission.documentLinks || '(Không có)',
    '',
    `Trang gửi: ${submission.pageUrl || '(Không xác định)'}`,
    `Thời gian UTC: ${new Date().toISOString()}`
  ].join('\n');
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\0/g, '').trim().slice(0, maxLength);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function normalizeShopDomain(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');
}

function normalizeTemplateFilename(value) {
  const filename = String(value || '').trim();
  return /^templates\/[a-z0-9_-]+(?:\.[a-z0-9_-]+)?\.json$/i.test(filename)
    ? filename
    : '';
}

function parseList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function setCorsHeaders(origin, allowedOrigins, res) {
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getClientIp(req) {
  const forwarded = String(req.headers && req.headers['x-forwarded-for'] || '');
  return forwarded.split(',')[0].trim() || String(req.socket && req.socket.remoteAddress || 'unknown');
}

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (requestLog.get(ip) || []).filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  requestLog.set(ip, recent);

  if (requestLog.size > 1000) {
    for (const [key, timestamps] of requestLog.entries()) {
      if (!timestamps.some(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS)) {
        requestLog.delete(key);
      }
    }
  }

  return recent.length > RATE_LIMIT_MAX_REQUESTS;
}
