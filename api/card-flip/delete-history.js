const {
  setCorsHeaders,
  handleError,
  deleteGameHistory,
  httpError
} = require('../../lib/card-flip-store');

module.exports = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = parseBody(req.body);
    const result = await deleteGameHistory(body);
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error);
  }
};

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (error) {
      throw httpError(400, 'Invalid JSON body');
    }
  }
  return body;
}
