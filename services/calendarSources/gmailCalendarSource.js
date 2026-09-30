/**
 * Gmail / Google Calendar Source — v2 stub.
 *
 * Keeps the interface seam intact so the v2 OAuth + Google Calendar API
 * implementation can land without a refactor of CalendarSuggester or main.js.
 * Any call into this source today returns the same "not-implemented" signal
 * the suggester already understands.
 */

class GmailCalendarSource {
  // eslint-disable-next-line no-unused-vars
  constructor(_opts = {}) {
    // No state in v1.
  }

  async ensurePermission() {
    return 'denied';
  }

  // eslint-disable-next-line no-unused-vars
  async getUpcomingEvents(_opts) {
    return { events: [], error: 'not-implemented' };
  }

  async getCurrentEvent() {
    return { event: null, error: 'not-implemented' };
  }
}

module.exports = { GmailCalendarSource };
