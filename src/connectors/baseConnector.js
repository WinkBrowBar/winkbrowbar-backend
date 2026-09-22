/**
 * Every connector must implement: async send(conversionData, credentials)
 * conversionData shape (standard, platform-agnostic):
 * {
 *   clickId: string | null,        // gclid / fbclid / awin click id - whichever applies
 *   email: string | null,
 *   phone: string | null,
 *   amount: number,
 *   currency: string,
 *   eventTime: Date,
 *   orderId: string                // our invoice id, used for dedupe
 * }
 *
 * Must return: { success: boolean, response: object, error?: string }
 * This is the contract that makes connectors swappable - the core engine
 * never needs to know which platform it's talking to.
 */
class BaseConnector {
  async send(conversionData, credentials) {
    throw new Error('send() must be implemented by connector');
  }
}

module.exports = { BaseConnector };
