/**
 * Shopify Draft Order API
 * Create draft order with line item discounts for tier pricing
 * 
 * Deploy to: Vercel, Netlify, or any serverless platform
 */

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP; // your-shop.myshopify.com
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // Admin API access token
const API_VERSION = '2024-10'; // Shopify API version

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
  
  // Validate environment variables
  if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
    return res.status(500).json({ 
      error: 'Server configuration error',
      message: 'Missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN environment variables'
    });
  }
  
  // Log config (without exposing full token)
  console.log('Config:', {
    shop: SHOPIFY_SHOP,
    tokenPrefix: SHOPIFY_ACCESS_TOKEN?.substring(0, 10) + '...',
    apiVersion: API_VERSION
  });
  
  try {
    const { customer_id, items, customer_email } = req.body;
    
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No items provided' });
    }
    
    // Validate items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.variant_id) {
        return res.status(400).json({ error: `Item ${i}: variant_id is required` });
      }
      if (!item.quantity || item.quantity <= 0) {
        return res.status(400).json({ error: `Item ${i}: quantity must be greater than 0` });
      }
      if (item.price === undefined || item.price < 0) {
        return res.status(400).json({ error: `Item ${i}: price must be a positive number` });
      }
      if (item.discount_percent < 0 || item.discount_percent > 100) {
        return res.status(400).json({ error: `Item ${i}: discount_percent must be between 0 and 100` });
      }
    }
    
    console.log('Creating draft order:', { customer_id, items });
    
    // Build line items with discounts
    const lineItems = items.map(item => {
      const lineItem = {
        variant_id: item.variant_id,
        quantity: item.quantity
      };
      
      // Add discount if applicable
      if (item.discount_percent > 0) {
        lineItem.applied_discount = {
          description: `Tier Discount ${item.discount_percent}%`,
          value_type: 'percentage',
          value: item.discount_percent.toString(),
          amount: calculateDiscountAmount(item.price, item.quantity, item.discount_percent)
        };
      }
      
      return lineItem;
    });
    
    // Create draft order payload
    const draftOrderData = {
      line_items: lineItems,
      use_customer_default_address: true
    };
    
    // Add customer info
    if (customer_id) {
      draftOrderData.customer = { id: customer_id };
    } else if (customer_email) {
      draftOrderData.email = customer_email;
    }
    
    // Call Shopify API
    const apiUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/draft_orders.json`;
    console.log('Calling Shopify API:', apiUrl);
    console.log('Draft order data:', JSON.stringify(draftOrderData, null, 2));
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ draft_order: draftOrderData })
    });
    
    console.log('Shopify API response status:', response.status);
    
    if (!response.ok) {
      const error = await response.text();
      console.error('Shopify API error:', {
        status: response.status,
        statusText: response.statusText,
        body: error
      });
      return res.status(response.status).json({ 
        error: 'Failed to create draft order', 
        details: error,
        status: response.status,
        shop: SHOPIFY_SHOP
      });
    }
    
    const data = await response.json();
    const draftOrder = data.draft_order;
    
    console.log('Draft order created:', draftOrder.id);
    
    // Complete draft order to generate invoice
    const completeResponse = await fetch(
      `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/draft_orders/${draftOrder.id}/complete.json`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        }
      }
    );
    
    if (!completeResponse.ok) {
      const error = await completeResponse.text();
      console.error('Failed to complete draft order:', error);
      return res.status(completeResponse.status).json({ error: 'Failed to complete draft order', details: error });
    }
    
    const completedData = await completeResponse.json();
    const completedOrder = completedData.draft_order;
    
    // Return invoice URL
    return res.status(200).json({
      success: true,
      invoice_url: completedOrder.invoice_url,
      draft_order_id: completedOrder.id,
      total_price: completedOrder.total_price
    });
    
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

function calculateDiscountAmount(price, quantity, percent) {
  const totalPrice = price * quantity;
  const discountAmount = (totalPrice * percent / 100).toFixed(2);
  return discountAmount;
}
