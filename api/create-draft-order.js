/**
 * Shopify Draft Order API
 * Create a draft order with exact, currency-aware line item discounts.
 */

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const DEFAULT_CURRENCY = (process.env.SHOPIFY_CURRENCY || 'VND').toUpperCase();
const API_VERSION = '2026-07';

// Shopify storefront prices use currency-specific integer units. Most
// currencies use 100 units per major unit, while zero-decimal currencies such
// as VND use the displayed amount directly.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF',
  'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'
]);

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

module.exports = async (req, res) => {
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
      message: 'Missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN environment variables'
    });
  }

  console.log('Config:', {
    shop: SHOPIFY_SHOP,
    tokenPrefix: SHOPIFY_ACCESS_TOKEN?.substring(0, 10) + '...',
    apiVersion: API_VERSION,
    defaultCurrency: DEFAULT_CURRENCY
  });

  try {
    const { customer_id, customer_email, items } = req.body;
    const currency = normalizeCurrency(req.body.currency || DEFAULT_CURRENCY);

    if (!currency) {
      return res.status(400).json({
        error: 'A valid 3-letter currency code is required'
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided' });
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const quantity = Number(item.quantity);
      const price = getUnitPrice(item, currency);
      const discountPercent = Number(item.discount_percent || 0);

      if (!item.variant_id) {
        return res.status(400).json({ error: `Item ${i}: variant_id is required` });
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({
          error: `Item ${i}: quantity must be a positive integer`
        });
      }
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({
          error: `Item ${i}: price_minor or price must be a positive number`
        });
      }
      if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
        return res.status(400).json({
          error: `Item ${i}: discount_percent must be between 0 and 100`
        });
      }
    }

    console.log('Creating draft order:', { customer_id, currency, items });

    const lineItems = items.map(item => {
      const price = getUnitPrice(item, currency);
      const discountPercent = Number(item.discount_percent || 0);
      const displayDiscountPercent = normalizeDiscountPercent(discountPercent);
      const unitDiscountAmount = calculateUnitDiscountAmount(price, discountPercent);
      const lineItem = {
        variantId: toProductVariantGid(item.variant_id),
        quantity: Number(item.quantity)
      };

      if (unitDiscountAmount > 0) {
        const discountTitle = item.is_gift
          ? 'Quà tặng miễn phí'
          : `Tier Discount ${displayDiscountPercent}%`;
        const formattedDiscount = formatMoney(unitDiscountAmount);

        // A per-unit fixed amount preserves the exact displayed tier price.
        // amountWithCurrency prevents the amount from being interpreted in the
        // store currency when the customer checks out in another currency.
        lineItem.appliedDiscount = {
          title: discountTitle,
          description: discountTitle,
          valueType: 'FIXED_AMOUNT',
          value: Number(formattedDiscount),
          amountWithCurrency: {
            amount: formattedDiscount,
            currencyCode: currency
          }
        };
      }

      return lineItem;
    });

    const draftOrderInput = {
      lineItems,
      presentmentCurrencyCode: currency,
      useCustomerDefaultAddress: true,
      acceptAutomaticDiscounts: false
    };

    if (customer_id) {
      draftOrderInput.purchasingEntity = {
        customerId: toCustomerGid(customer_id)
      };
    } else if (customer_email) {
      draftOrderInput.email = customer_email;
    }

    const apiUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`;
    console.log('Calling Shopify API:', apiUrl);
    console.log('Draft order data:', JSON.stringify(draftOrderInput, null, 2));

    const draftOrder = await createDraftOrderWithRetry(apiUrl, draftOrderInput);

    return res.status(200).json({
      success: true,
      invoice_url: draftOrder.invoiceUrl,
      draft_order_id: draftOrder.legacyResourceId,
      total_price: draftOrder.totalPriceSet.presentmentMoney.amount,
      currency: draftOrder.presentmentCurrencyCode
    });
  } catch (error) {
    console.error('Error:', error);
    const statusCode = error.statusCode || 500;

    return res.status(statusCode).json({
      error: statusCode === 422
        ? 'Shopify rejected the draft order'
        : 'Internal server error',
      message: error.message
    });
  }
};

async function createDraftOrderWithRetry(apiUrl, draftOrderInput, retryCount = 0) {
  const query = `
    mutation DraftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          legacyResourceId
          invoiceUrl
          presentmentCurrencyCode
          totalPriceSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({
        query,
        variables: { input: draftOrderInput }
      })
    });

    console.log('Shopify API response status:', response.status);

    if (response.status === 429) {
      if (retryCount < MAX_RETRIES) {
        const retryAfter = response.headers.get('Retry-After');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : INITIAL_RETRY_DELAY * Math.pow(2, retryCount);

        console.log(
          `Rate limited. Retrying after ${delay}ms ` +
          `(attempt ${retryCount + 1}/${MAX_RETRIES})`
        );
        await sleep(delay);
        return createDraftOrderWithRetry(apiUrl, draftOrderInput, retryCount + 1);
      }

      throw new Error('Shopify API rate limit exceeded. Please try again later.');
    }

    if (!response.ok) {
      const responseBody = await response.text();
      console.error('Shopify API error:', {
        status: response.status,
        statusText: response.statusText,
        body: responseBody
      });

      if (response.status >= 500 && retryCount < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
        console.log(
          `Server error. Retrying after ${delay}ms ` +
          `(attempt ${retryCount + 1}/${MAX_RETRIES})`
        );
        await sleep(delay);
        return createDraftOrderWithRetry(apiUrl, draftOrderInput, retryCount + 1);
      }

      const shopifyError = new Error(
        `Shopify API error: ${response.status} - ${responseBody}`
      );
      shopifyError.statusCode =
        response.status >= 400 && response.status < 500 ? 422 : 500;
      throw shopifyError;
    }

    const data = await response.json();
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      const shopifyError = new Error(
        data.errors.map(error => error.message).join('; ')
      );
      shopifyError.statusCode = 422;
      throw shopifyError;
    }

    const result = data.data && data.data.draftOrderCreate;
    if (!result) {
      throw new Error('Shopify returned an invalid draft order response');
    }

    if (Array.isArray(result.userErrors) && result.userErrors.length > 0) {
      const shopifyError = new Error(
        result.userErrors.map(error => error.message).join('; ')
      );
      shopifyError.statusCode = 422;
      throw shopifyError;
    }

    if (!result.draftOrder || !result.draftOrder.invoiceUrl) {
      throw new Error('Shopify did not return a draft order checkout URL');
    }

    console.log('Draft order created:', result.draftOrder.id);
    return result.draftOrder;
  } catch (error) {
    if (
      retryCount < MAX_RETRIES &&
      !error.statusCode &&
      (error.message.includes('fetch') || error.name === 'TypeError')
    ) {
      const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
      console.log(
        `Network error. Retrying after ${delay}ms ` +
        `(attempt ${retryCount + 1}/${MAX_RETRIES})`
      );
      await sleep(delay);
      return createDraftOrderWithRetry(apiUrl, draftOrderInput, retryCount + 1);
    }

    throw error;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateUnitDiscountAmount(price, percent) {
  const rawDiscountAmount = Number(price) * Number(percent) / 100;
  return Math.min(Number(price), Math.max(0, rawDiscountAmount));
}

function formatMoney(value) {
  return Number(value).toFixed(2);
}

/**
 * Convert a Shopify storefront integer price into the major currency unit.
 * `price` is retained for cached clients that divided the raw value by 100.
 */
function getUnitPrice(item, currency) {
  if (item.price_minor !== undefined && item.price_minor !== null) {
    const rawPrice = Number(item.price_minor);
    return ZERO_DECIMAL_CURRENCIES.has(currency) ? rawPrice : rawPrice / 100;
  }

  const legacyPrice = Number(item.price);
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? legacyPrice * 100 : legacyPrice;
}

function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : '';
}

function toProductVariantGid(variantId) {
  const value = String(variantId);
  return value.startsWith('gid://shopify/ProductVariant/')
    ? value
    : `gid://shopify/ProductVariant/${value}`;
}

function toCustomerGid(customerId) {
  const value = String(customerId);
  return value.startsWith('gid://shopify/Customer/')
    ? value
    : `gid://shopify/Customer/${value}`;
}

function normalizeDiscountPercent(percent) {
  const boundedPercent = Math.min(100, Math.max(0, Number(percent)));
  return Math.round((boundedPercent + Number.EPSILON) * 100) / 100;
}
