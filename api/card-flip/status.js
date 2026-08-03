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
    const limit = getLimit(req.query.limit, 100);

    return res.status(200).json({
      success: true,
      campaign_id: state.campaignId,
      customer_id: state.numericId,
      customer_email: state.customer.email || '',
      allowed_turns: state.allowedTurns,
      used_turns: state.usedTurns,
      remaining_turns: state.remainingTurns,
      qualifying_order_days: state.qualifyingOrderDays,
      daily_order_amount: state.config.dailyOrderAmount,
      campaign_end_date: state.config.campaignEndDate,
      campaign_time_zone: state.config.timeZone,
      is_campaign_active: state.campaignActive,
      accumulated_order_amount: state.accumulatedOrderAmount,
      history: state.campaignHistory.slice(0, limit)
    });
  } catch (error) {
    return handleError(res, error);
  }
};

function getLimit(value, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.min(number, 200);
}
