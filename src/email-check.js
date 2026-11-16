/**
 * Motorq Capability Check: work email validation (step 2).
 *
 * Blocks personal emails using a short list of free email providers.
 * Providers with country-specific domains (yahoo.co.uk, hotmail.com.ar, gmx.de…)
 * are covered by a pattern so every TLD doesn't need to be listed.
 *
 * Exposes window.MotorqEmail in the browser and module.exports in Node (tests).
 */
(function (root) {
  'use strict';

  var ERRORS = {
    REQUIRED: 'email_required',
    INVALID: 'email_invalid',
    PERSONAL: 'email_personal',
  };

  // Basic format: name@domain.tld (strict validation happens in the backend).
  // The name part only allows the characters valid in an unquoted address, so
  // HTML like "<img ...>" is rejected. Domains may use accented letters (IDN).
  var EMAIL_FORMAT = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@([\p{L}\p{N}-]+\.)+(\p{L}{2,}|xn--[a-z0-9-]+)$/iu;

  // Providers that exist under many country domains.
  // Matches provider + .com / .net / .org / .<country> / .co.<country> / .com.<country>
  var PROVIDERS_ANY_TLD = [
    'gmail', 'googlemail', 'yahoo', 'ymail', 'rocketmail',
    'hotmail', 'outlook', 'live', 'msn', 'windowslive',
    'aol', 'aim', 'gmx', 'yandex', 'mail', 'zoho', 'inbox',
  ];
  // Only real country domains where these providers operate. Generic ones that
  // companies use (.io, .ai, .tv, .co, .me…) are left out on purpose.
  var COUNTRIES = [
    'ar', 'at', 'au', 'be', 'bg', 'br', 'by', 'ca', 'ch', 'cl', 'cn', 'cz', 'de',
    'dk', 'ee', 'es', 'fi', 'fr', 'gr', 'hk', 'hr', 'hu', 'id', 'ie', 'il', 'in',
    'it', 'jp', 'kr', 'kz', 'lt', 'lu', 'lv', 'mx', 'my', 'nl', 'no', 'nz', 'pe',
    'ph', 'pl', 'pt', 'ro', 'rs', 'ru', 'se', 'sg', 'si', 'sk', 'th', 'tr', 'tw',
    'ua', 'uk', 'uy', 've', 'vn', 'za',
  ].join('|');
  var ANY_TLD_PATTERN = new RegExp(
    '^(' + PROVIDERS_ANY_TLD.join('|') + ')\\.(com|net|org|' + COUNTRIES + '|com?\\.(' + COUNTRIES + '))$'
  );

  // Specific domains.
  var DOMAINS = [
    // Apple
    'icloud.com', 'me.com', 'mac.com',
    // Privacy-focused
    'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'tutanota.com',
    'tutanota.de', 'tuta.io', 'tuta.com', 'hushmail.com', 'mailfence.com',
    // Other global providers and ISPs
    'fastmail.com', 'fastmail.fm', 'hey.com', 'mail.com', 'email.com',
    'usa.com', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'comcast.net',
    'verizon.net', 'cox.net', 'charter.net', 'earthlink.net', 'juno.com',
    'optonline.net', 'frontier.com', 'rogers.com', 'shaw.ca', 'sympatico.ca',
    // Europe
    'web.de', 'freenet.de', 't-online.de', 'orange.fr', 'wanadoo.fr',
    'free.fr', 'laposte.net', 'sfr.fr', 'libero.it', 'virgilio.it',
    'tiscali.it', 'btinternet.com', 'sky.com', 'virginmedia.com',
    'seznam.cz', 'wp.pl', 'o2.pl', 'interia.pl', 'onet.pl',
    'rambler.ru', 'list.ru', 'bk.ru', 'ukr.net',
    // Asia
    'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com', 'aliyun.com',
    'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com',
    'foxmail.com', 'yeah.net', '139.com', '188.com', 'sina.cn',
    // Russia, Europe and Oceania (more)
    'ya.ru', 'posteo.de', 'mailbox.org', 'duck.com',
    'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'xtra.co.nz',
    // Latam
    'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br',
    'fibertel.com.ar', 'speedy.com.ar', 'arnet.com.ar', 'prodigy.net.mx',
    // Disposable addresses
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com',
    'yopmail.com', '10minutemail.com', 'temp-mail.org', 'trashmail.com',
    'getnada.com', 'maildrop.cc', 'dispostable.com',
  ];

  var DOMAIN_SET = Object.create(null);
  DOMAINS.forEach(function (d) { DOMAIN_SET[d] = true; });

  function getDomain(email) {
    var at = email.lastIndexOf('@');
    return at === -1 ? '' : email.slice(at + 1);
  }

  function isPersonalDomain(domain) {
    domain = String(domain || '').toLowerCase().trim();
    return !!DOMAIN_SET[domain] || ANY_TLD_PATTERN.test(domain);
  }

  /** Returns { ok: true, email } or { ok: false, error }. */
  function validateWorkEmail(value) {
    var email = String(value || '').trim().toLowerCase();
    if (!email) return { ok: false, error: ERRORS.REQUIRED };
    if (!EMAIL_FORMAT.test(email)) return { ok: false, error: ERRORS.INVALID };
    if (isPersonalDomain(getDomain(email))) return { ok: false, error: ERRORS.PERSONAL };
    return { ok: true, email: email };
  }

  var api = {
    ERRORS: ERRORS,
    validateWorkEmail: validateWorkEmail,
    isPersonalDomain: isPersonalDomain,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MotorqEmail = api;
})(typeof window !== 'undefined' ? window : this);
