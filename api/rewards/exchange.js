/**
 * Rewards Exchange API
 * Đổi điểm thưởng lấy mã giảm giá
 * 
 * POST /api/rewards/exchange
 * Body: { customer_id, discount_value }
 */

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2024-10';

// Cấu hình đổi điểm (tỷ lệ 1:1 - 1000 điểm = 1000 VND)
const EXCHANGE_RATES = {
    50000: 50000,   // 50.000 VND = 50.000 điểm
    100000: 100000, // 100.000 VND = 100.000 điểm
    200000: 200000, // 200.000 VND = 200.000 điểm
    500000: 500000  // 500.000 VND = 500.000 điểm
};

const MIN_POINTS_REQUIRED = 50000;

module.exports = async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
        return res.status(500).json({
            error: 'Server configuration error',
            message: 'Missing environment variables'
        });
    }

    try {
        const { customer_id, discount_value } = req.body;

        if (!customer_id) {
            return res.status(400).json({ error: 'customer_id is required' });
        }

        if (!discount_value || !EXCHANGE_RATES[discount_value]) {
            return res.status(400).json({
                error: 'Invalid discount_value',
                valid_values: Object.keys(EXCHANGE_RATES).map(v => parseInt(v))
            });
        }

        // Kiểm tra thời hạn chương trình
        const DEADLINE = new Date('2026-03-04T00:00:00+07:00'); // Hết ngày 03/03/2026
        if (new Date() > DEADLINE) {
            return res.status(400).json({
                error: 'Chương trình đổi điểm đã kết thúc vào ngày 03/03/2026'
            });
        }

        const pointsRequired = EXCHANGE_RATES[discount_value];

        // 1. Lấy thông tin customer và điểm hiện tại
        const customer = await getCustomer(customer_id);
        if (!customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const currentPoints = await getCustomerPoints(customer_id);

        if (currentPoints < pointsRequired) {
            return res.status(400).json({
                error: 'Không đủ điểm',
                current_points: currentPoints,
                points_required: pointsRequired
            });
        }

        // 2. Tạo mã gift card
        const giftCardCode = await createGiftCard(discount_value, customer_id); // Pass customer_id for GC
        if (!giftCardCode) {
            return res.status(500).json({ error: 'Failed to create gift card' });
        }

        // 3. Trừ điểm
        const newPoints = currentPoints - pointsRequired;
        await updateCustomerPoints(customer_id, newPoints);

        // 4. Lưu lịch sử
        await addRewardHistory(customer_id, {
            date: new Date().toISOString(),
            action: 'Đổi điểm lấy Gift Card',
            points_used: pointsRequired,
            discount_code: giftCardCode,
            amount_vnd: discount_value
        });

        console.log(`✅ Customer ${customer_id} exchanged ${pointsRequired} points for Gift Card ${giftCardCode}`);

        return res.status(200).json({
            success: true,
            discount_code: giftCardCode,
            discount_value: discount_value,
            points_used: pointsRequired,
            remaining_points: newPoints
        });

    } catch (error) {
        console.error('❌ Exchange error:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
};

/**
 * Lấy thông tin customer
 */
async function getCustomer(customerId) {
    const numericId = customerId.toString().replace(/\D/g, '');
    const response = await fetch(
        `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/customers/${numericId}.json`,
        {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
            }
        }
    );

    if (!response.ok) {
        console.error('Failed to get customer:', response.status);
        return null;
    }

    const data = await response.json();
    return data.customer;
}

/**
 * Lấy điểm hiện tại của customer từ metafield
 */
async function getCustomerPoints(customerId) {
    const numericId = customerId.toString().replace(/\D/g, '');
    const response = await fetch(
        `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/customers/${numericId}/metafields.json?namespace=rewards&key=points`,
        {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
            }
        }
    );

    if (!response.ok) {
        return 0;
    }

    const data = await response.json();
    const pointsMetafield = data.metafields?.find(m => m.key === 'points');
    return pointsMetafield ? parseInt(pointsMetafield.value) || 0 : 0;
}

/**
 * Cập nhật điểm của customer
 */
async function updateCustomerPoints(customerId, newPoints) {
    const numericId = customerId.toString().replace(/\D/g, '');

    const response = await fetch(
        `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/customers/${numericId}/metafields.json`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
            },
            body: JSON.stringify({
                metafield: {
                    namespace: 'rewards',
                    key: 'points',
                    value: newPoints.toString(),
                    type: 'number_integer'
                }
            })
        }
    );

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to update points: ${error}`);
    }

    return true;
}

/**
 * Tạo Gift Card
 */
async function createGiftCard(amountVnd, customerId) {
    // Gift Card code (optional: let Shopify generate or custom)
    // Shopify auto-generates if code is not provided, or we can provide a custom one.
    // Let's generate a custom one to have a prefix like 'RWD-'
    const code = `RWD-${generateCode(12)}`; // 12 chars for better security

    const response = await fetch(
        `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/gift_cards.json`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
            },
            body: JSON.stringify({
                gift_card: {
                    initial_value: amountVnd.toString(),
                    code: code,
                    customer_id: customerId,
                    note: 'Đổi điểm thưởng Helios Rewards',
                    expires_on: '2026-03-03'
                }
            })
        }
    );

    if (!response.ok) {
        const error = await response.text();
        console.error('Failed to create gift card:', error);

        // Check for permission error specifically
        if (response.status === 403) {
            console.error('PERMISSION ERROR: App is missing write_gift_cards scope.');
            throw new Error('Missing write_gift_cards permission');
        }

        return null;
    }

    const data = await response.json();
    return data.gift_card.code; // Return the actual code (Shopify might normalize it)
}

/**
 * Thêm lịch sử đổi điểm
 */
async function addRewardHistory(customerId, historyEntry) {
    const numericId = customerId.toString().replace(/\D/g, '');

    // Lấy lịch sử hiện tại
    const getResponse = await fetch(
        `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/customers/${numericId}/metafields.json?namespace=rewards&key=history`,
        {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
            }
        }
    );

    let history = [];
    if (getResponse.ok) {
        const data = await getResponse.json();
        const historyMetafield = data.metafields?.find(m => m.key === 'history');
        if (historyMetafield) {
            try {
                if (typeof historyMetafield.value === 'string') {
                    history = JSON.parse(historyMetafield.value);
                } else {
                    history = historyMetafield.value;
                }
            } catch (e) {
                history = [];
            }
        }
    }

    // Thêm entry mới
    history.unshift(historyEntry);

    // Giới hạn 100 entries
    if (history.length > 100) {
        history = history.slice(0, 100);
    }

    // Lưu lại
    await fetch(
        `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/customers/${numericId}/metafields.json`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
            },
            body: JSON.stringify({
                metafield: {
                    namespace: 'rewards',
                    key: 'history',
                    value: JSON.stringify(history),
                    type: 'json'
                }
            })
        }
    );
}

/**
 * Tạo mã ngẫu nhiên
 */
function generateCode(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
