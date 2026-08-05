const {
  setCorsHeaders,
  handleError,
  getCardInventory,
  updateCardInventory,
  httpError
} = require('../../lib/card-flip-store');

module.exports = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await getCardInventory(req.query));
    }

    if (req.method === 'POST') {
      return res.status(200).json(await updateCardInventory(parseBody(req.body)));
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
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
