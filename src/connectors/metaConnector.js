const axios = require('axios');
const crypto = require('crypto');
const { BaseConnector } = require('./baseConnector');

/**
 * Meta Conversions API connector - Phase 2.
 * Skeleton is complete and matches Meta's expected payload shape;
 * verify field names against Meta's current CAPI docs before going live,
 * since Meta occasionally revises required fields.
 */
class MetaConnector extends BaseConnector {
  hash(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  }

  async send(conversionData, credentials) {
    const { pixelId, accessToken } = credentials;
    const { email, phone, amount, currency, orderId, eventTime } = conversionData;

    try {
      const response = await axios.post(
        `https://graph.facebook.com/v20.0/${pixelId}/events`,
        {
          data: [
            {
              event_name: 'Purchase',
              event_time: Math.floor((eventTime || new Date()).getTime() / 1000),
              action_source: 'system_generated', // offline conversion
              user_data: {
                em: email ? [this.hash(email)] : undefined,
                ph: phone ? [this.hash(phone)] : undefined,
              },
              custom_data: {
                currency: currency || 'INR',
                value: amount,
                order_id: orderId,
              },
            },
          ],
          access_token: accessToken,
        },
        { timeout: 10000 }
      );
      return { success: true, response: response.data };
    } catch (err) {
      return { success: false, response: err.response ? err.response.data : null, error: err.message };
    }
  }
  /**
   * Pulls campaign-level spend from Meta's Ads Insights API (confirmed
   * endpoint shape per developers.facebook.com/documentation/ads-commerce/
   * marketing-api/insights, checked 2026-08-20).
   *
   * REQUIRES: credentials.adAccountId (the ad account, e.g. "act_1234567890"
   * or just the numeric ID - either works, normalized below) and an access
   * token with the `ads_read` permission. This is a DIFFERENT permission
   * scope than what the Conversions API send() above needs - the existing
   * accessToken in MarketingPlatform may not have it. Verify with a real
   * call before relying on this; if it 403s, the token needs `ads_read`
   * added via Meta's Graph API Explorer or a fresh token generation.
   */
  async fetchSpend({ adAccountId, accessToken }, { since, until }) {
    if (!adAccountId) {
      return { success: false, spend: [], error: 'No adAccountId configured for this brand\'s Meta credentials' };
    }
    const account = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
    const fmt = (d) => d.toISOString().slice(0, 10);

    try {
      const response = await axios.get(`https://graph.facebook.com/v20.0/${account}/insights`, {
        params: {
          level: 'campaign',
          fields: 'campaign_id,campaign_name,spend',
          time_range: JSON.stringify({ since: fmt(since), until: fmt(until) }),
          time_increment: 1, // one row per campaign per day, so it maps cleanly onto AdSpend's one-row-per-day shape
          access_token: accessToken,
        },
        timeout: 15000,
      });

      const spend = (response.data.data || []).map((row) => ({
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        date: row.date_start,
        spend: Number(row.spend),
        currency: 'USD', // Insights doesn't return currency per row - comes from the ad account's own currency setting
      }));
      return { success: true, spend };
    } catch (err) {
      return { success: false, spend: [], error: err.response ? JSON.stringify(err.response.data) : err.message };
    }
  }
}

module.exports = new MetaConnector();