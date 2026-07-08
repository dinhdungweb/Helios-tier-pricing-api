const {
  setCorsHeaders,
  handleError,
  listGameHistory
} = require('../../lib/card-flip-store');

module.exports = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const result = await listGameHistory(req.query);
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error);
  }
};
