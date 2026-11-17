/**
 * Motorq Capability Check: contact field helpers (step 2 and Talk to an Expert).
 *
 * Pure logic, no DOM. Exposes window.MotorqContact in the browser and
 * module.exports in Node (tests).
 */
(function (root) {
  'use strict';

  var ERRORS = {
    PHONE_REQUIRED: 'phone_required',
    PHONE_INVALID: 'phone_invalid',
  };

  // The `fleet_size` options of Motorq's HubSpot forms. Values must match them
  // exactly. Replace through the `fleetSizes` option of MotorqCapCheck.init.
  var FLEET_SIZES = ['1-50', '50-250', '250-500', '500-1,000', 'More than 1,000'];

  // Country codes for the phone select. Replace through the `phoneCountries` option.
  var PHONE_COUNTRIES = [
    { value: '+1', label: 'US/CA +1' },
    { value: '+52', label: 'MX +52' },
    { value: '+44', label: 'UK +44' },
    { value: '+49', label: 'DE +49' },
    { value: '+33', label: 'FR +33' },
    { value: '+34', label: 'ES +34' },
    { value: '+39', label: 'IT +39' },
    { value: '+31', label: 'NL +31' },
    { value: '+55', label: 'BR +55' },
    { value: '+54', label: 'AR +54' },
    { value: '+57', label: 'CO +57' },
    { value: '+56', label: 'CL +56' },
    { value: '+91', label: 'IN +91' },
    { value: '+61', label: 'AU +61' },
    { value: '+81', label: 'JP +81' },
  ];

  /** "Jane" + "Doe" → "Jane Doe". Extra spaces are collapsed and trimmed. */
  function joinName(first, last) {
    return [first, last]
      .map(function (part) { return String(part == null ? '' : part).replace(/\s+/g, ' ').trim(); })
      .filter(Boolean)
      .join(' ');
  }

  /**
   * Basic phone check: digits, spaces, dashes and parentheses only, with
   * 6 to 15 digits. Returns { ok: true, phone } (trimmed) or { ok: false, error }.
   */
  function validatePhone(value) {
    var phone = String(value == null ? '' : value).trim();
    if (!phone) return { ok: false, error: ERRORS.PHONE_REQUIRED };
    if (!/^[0-9\s()-]+$/.test(phone)) return { ok: false, error: ERRORS.PHONE_INVALID };
    var digits = phone.replace(/\D/g, '').length;
    if (digits < 6 || digits > 15) return { ok: false, error: ERRORS.PHONE_INVALID };
    return { ok: true, phone: phone };
  }

  var api = {
    ERRORS: ERRORS,
    FLEET_SIZES: FLEET_SIZES,
    PHONE_COUNTRIES: PHONE_COUNTRIES,
    joinName: joinName,
    validatePhone: validatePhone,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MotorqContact = api;
})(typeof window !== 'undefined' ? window : this);
