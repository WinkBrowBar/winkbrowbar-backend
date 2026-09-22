const axios = require('axios');
const crypto = require('crypto');
const { BaseConnector } = require('./baseConnector');

/**
 * Google Ads connector - Phase 3, via the Data Manager API.
 *
 * CONFIRMED as of 2026-07-30 (developers.google.com/data-manager):
 *  - Endpoint: POST https://datamanager.googleapis.com/v1/events:ingest
 *  - Requires OAuth2 access token with scope
 *    https://www.googleapis.com/auth/datamanager (NOT a static API key,
 *    unlike Meta/AWIN/Klaviyo - this is why Google needs its own OAuth
 *    refresh step below).
 *  - Body shape: { destinations: [...], events: [...], validate_only }
 *  - Max 2000 events per request (irrelevant here, we send 1 at a time)
 *
 * NOT FULLY CONFIRMED - verify before trusting in production:
 *  - The exact field names inside a single Event object (identifiers,
 *    transaction_id, value, event_timestamp) are built from Google's
 *    general Event resource shape, not a directly-verified working
 *    example. Google's own docs are JS-rendered and couldn't be fully
 *    read via search/fetch the way AWIN's were.
 *  - RECOMMENDATION: run with validate_only=true first (see below) and
 *    check the response/field_warnings before ever sending a real event.
 */
class GoogleConnector extends BaseConnector {
  hash(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  }

  /**
   * Google Ads API access tokens expire quickly (~1 hour), so every call
   * exchanges the long-lived refresh token for a fresh short-lived one.
   */
  async getAccessToken(credentials) {
    const { clientId, clientSecret, refreshToken } = credentials;
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    return response.data.access_token;
  }

  async send(conversionData, credentials) {
    const { developerToken, customerId, conversionActionId } = credentials;
    const { clickId, email, phone, amount, currency, orderId, eventTime } = conversionData;

    if (!clickId) {
      return { success: false, response: null, error: 'Missing Google click id (gclid) - cannot attribute this sale' };
    }
    if (!conversionActionId) {
      return { success: false, response: null, error: 'Missing conversionActionId - required as destinations[0].productDestinationId. Find it in Google Ads under Goals > Conversions.' };
    }

    let accessToken;
    try {
      accessToken = await this.getAccessToken(credentials);
    } catch (err) {
      return { success: false, response: err.response ? err.response.data : null, error: `OAuth token refresh failed: ${err.message}` };
    }

    const eventTimestamp = (eventTime || new Date()).toISOString();

    try {
      const response = await axios.post(
        'https://datamanager.googleapis.com/v1/events:ingest',
        {
          destinations: [
            {
              // 'product' is deprecated in favor of 'accountType' per the
              // Destination resource docs - using the current field name.
              operatingAccount: {
                accountType: 'GOOGLE_ADS',
                accountId: customerId,
              },
              // Required. Google Ads Conversion Action ID (Goals > Conversions
              // in Google Ads). Must be a plain numeric string - Google
              // rejects it with INVALID_NUMBER_FORMAT otherwise.
              productDestinationId: String(conversionActionId),
            },
          ],
          events: [
            {
              eventSource: 'WEB', // confirmed against Data Manager API EventSource enum (WEB/APP/IN_STORE/PHONE/MESSAGE/OTHER)
              eventTimestamp,
              transactionId: orderId,
              userData: {
                userIdentifiers: [
                  ...(email ? [{ emailAddress: this.hash(email) }] : []),
                  ...(phone ? [{ phoneNumber: this.hash(phone) }] : []),
                ],
              },
              adIdentifiers: {
                gclid: clickId,
              },
              // Confirmed against Google's official Data Manager API reference
              // (developers.google.com/data-manager/api/reference/rest/v1/events/ingest):
              // conversionValue and currency are separate flat scalar fields on
              // Event, NOT a nested { value, currencyCode } object. This was the
              // exact cause of the 400 "Starting an object on a scalar field" error.
              conversionValue: Number(amount),
              currency: currency || 'USD',
            },
          ],
          // Defaults to false (real send) unless the caller explicitly asks
          // for a dry run. Always pass validateOnly: true first and confirm
          // a clean response with no field_warnings before ever sending real.
          validateOnly: conversionData.validateOnly === true,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': developerToken,
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
  /**
   * Pulls campaign-level spend via the Google Ads API's GAQL search
   * endpoint. Uses the same OAuth refresh flow as send() above.
   *
   * NOT FULLY CONFIRMED - same status as the rest of this file. Built from
   * Google Ads API's documented query shape, not a directly-verified
   * working example. cost_micros is Google's documented unit (spend in
   * millionths of the account's currency) - dividing by 1,000,000 below.
   * REQUIRES credentials.customerId (already used by send()) and a
   * developer token approved for at least Basic Access.
   */
  async fetchSpend(credentials, { since, until }) {
    const { developerToken, customerId } = credentials;
    let accessToken;
    try {
      accessToken = await this.getAccessToken(credentials);
    } catch (err) {
      return { success: false, spend: [], error: `OAuth token refresh failed: ${err.message}` };
    }

    const fmt = (d) => d.toISOString().slice(0, 10);
    const query = `
      SELECT campaign.id, campaign.name, metrics.cost_micros, segments.date
      FROM campaign
      WHERE segments.date BETWEEN '${fmt(since)}' AND '${fmt(until)}'
    `;

    try {
      const response = await axios.post(
        // v17 sunset June 2025 - was 404ing. v25 is current as of Aug 2026;
        // check developers.google.com/google-ads/api/docs/sunset-dates
        // periodically, since versions retire roughly once a year.
        `https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:searchStream`,
        { query },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': developerToken,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      const rows = (response.data || []).flatMap((batch) => batch.results || []);
      const spend = rows.map((r) => ({
        campaignId: r.campaign.id,
        campaignName: r.campaign.name,
        date: r.segments.date,
        spend: Number(r.metrics.costMicros || 0) / 1_000_000,
        currency: 'USD', // verify against the account's actual currency setting
      }));
      return { success: true, spend };
    } catch (err) {
      return { success: false, spend: [], error: err.response ? JSON.stringify(err.response.data) : err.message };
    }
  }
}

module.exports = new GoogleConnector();