const axios = require('axios');
const { BaseConnector } = require('./baseConnector');

/**
 * AWIN Conversion API connector - Phase 1.
 * Confirmed against real AWIN documentation (help.awin.com/apidocs/conversion-api)
 * on 2026-07-30 - previous version used the wrong endpoint entirely
 * (/transactions/manual and /transactions/batch are for approving/declining
 * existing transactions, not creating new ones).
 *
 * Correct endpoint: POST https://api.awin.com/s2s/advertiser/{advertiserId}/orders
 * Correct auth: x-api-key header, NOT Bearer
 * Correct body: top-level {"orders": [...]}, each order requires commissionGroups
 */
class AwinConnector extends BaseConnector {
  async send(conversionData, credentials) {
    const { advertiserId, apiToken } = credentials;
    const { clickId, amount, currency, orderId, eventTime } = conversionData;

    if (!clickId) {
      return { success: false, response: null, error: 'Missing AWIN click id (awc) - cannot attribute this sale to AWIN' };
    }

    try {
      const response = await axios.post(
        `https://api.awin.com/s2s/advertiser/${advertiserId}/orders`,
        {
          orders: [
            {
              orderReference: String(orderId).slice(0, 50),
              amount,
              channel: 'aw',
              currency: currency || 'USD',
              awc: clickId,
              // commissionGroups is required by AWIN's schema even for a
              // simple single-total transaction - DEFAULT covers the whole
              // amount unless the brand later wants per-product splits.
              commissionGroups: [
                { code: 'DEFAULT', amount },
              ],
              custom: { 1: 's2sAPI' },
            },
          ],
        },
        {
          headers: {
            'x-api-key': apiToken,
            'Content-Type': 'application/json',
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


module.exports = new AwinConnector();
