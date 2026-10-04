const axios = require('axios');
const { BaseConnector } = require('./baseConnector');

/**
 * Klaviyo Events API (v3) connector.
 *
 * IMPORTANT - this file previously contained an exact duplicate of
 * awinConnector.js by mistake (wrong file content, not a logic bug) - every
 * Klaviyo send has been failing since then with an AWIN-specific error
 * ("Missing AWIN click id") because it was literally running AWIN's code.
 * This is the real implementation.
 *
 * Endpoint: POST https://a.klaviyo.com/api/events/
 * Auth: Authorization: Klaviyo-API-Key {privateApiKey}  (credentials.apiKey)
 * Docs: https://developers.klaviyo.com/en/reference/create_event
 *
 * VERIFY BEFORE RELYING ON THIS:
 * 1. The `revision` header date below should be checked against Klaviyo's
 *    current API revision at deploy time - Klaviyo versions its API by date
 *    and can deprecate old revisions.
 * 2. The metric name 'Placed Order' below is a common ecommerce convention,
 *    but if Umbreen's Klaviyo account already has flows/segments built
 *    around a specific existing event name, use that exact name instead -
 *    otherwise this will create a new, disconnected metric that her
 *    existing flows won't trigger from.
 */
class KlaviyoConnector extends BaseConnector {
  async send(conversionData, credentials) {
    const { apiKey } = credentials;
    const { email, phone, amount, currency, orderId, eventTime } = conversionData;

    if (!email && !phone) {
      return { success: false, response: null, error: 'Klaviyo requires at least an email or phone to identify the profile' };
    }

    try {
      const response = await axios.post(
        'https://a.klaviyo.com/api/events/',
        {
          data: {
            type: 'event',
            attributes: {
              properties: {
                OrderId: orderId,
                Currency: currency || 'USD',
              },
              value: amount,
              unique_id: String(orderId), // prevents duplicate events on retry
              time: (eventTime || new Date()).toISOString(),
              metric: {
                data: {
                  type: 'metric',
                  attributes: { name: 'Placed Order' },
                },
              },
              profile: {
                data: {
                  type: 'profile',
                  attributes: {
                    email: email || undefined,
                    phone_number: phone || undefined,
                  },
                },
              },
            },
          },
        },
        {
          headers: {
            Authorization: `Klaviyo-API-Key ${apiKey}`,
            'Content-Type': 'application/json',
            accept: 'application/json',
            revision: '2024-10-15',
          },
          timeout: 10000,
        }
      );
      return { success: true, response: response.data };
    } catch (err) {
      return {
        success: false,
        response: err.response ? err.response.data : null,
        error: err.message,
      };
    }
  }
}

module.exports = new KlaviyoConnector();