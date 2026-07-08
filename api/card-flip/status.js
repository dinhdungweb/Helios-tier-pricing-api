const {
  setCorsHeaders,
  handleError,
  getGameState
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
    const { customer_id, campaign_id } = req.query;
    const state = await getGameState(customer_id, campaign_id, req.query);

    return res.status(200).json({
      success: true,
      campaign_id: state.campaignId,
      customer_id: state.numericId,
      customer_email: state.customer.email || '',
      allowed_turns: state.allowedTurns,
      used_turns: state.usedTurns,
      remaining_turns: state.remainingTurns,
      history: state.campaignHistory.slice(0, 20)
    });
  } catch (error) {
    return handleError(res, error);
  }
};
