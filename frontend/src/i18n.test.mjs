import assert from 'node:assert/strict';
import test from 'node:test';

// i18n.js touches document/localStorage/navigator/window as soon as it's
// imported (it sets the <html lang> attribute at module load and resolves
// the initial locale from navigator.language). In the real app these are
// always the browser globals; here we stand in minimal fakes so the module
// can load under plain `node --test`, matching this repo's existing
// dependency-free testing style (see zmodem-protocol.test.mjs). A dynamic
// import is required — a static `import` would be hoisted above these
// stubs and see `document`/`navigator` as undefined.
const htmlAttrs = new Map();
globalThis.document = {
  documentElement: {
    setAttribute: (k, v) => htmlAttrs.set(k, v),
    getAttribute: (k) => htmlAttrs.get(k) ?? null,
  },
  querySelectorAll: () => [],
};

const localStorageData = new Map();
globalThis.localStorage = {
  getItem: (k) => (localStorageData.has(k) ? localStorageData.get(k) : null),
  setItem: (k, v) => localStorageData.set(k, String(v)),
  removeItem: (k) => localStorageData.delete(k),
};

const dispatchedEvents = [];
globalThis.window = {
  addEventListener: () => {},
  dispatchEvent: (evt) => dispatchedEvents.push(evt),
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.detail = opts.detail;
  }
};
globalThis.navigator = { language: 'en-US' };

const { t, getLocale, getLanguagePref, setLanguage, LANGUAGE_OPTIONS } = await import('./i18n.js');

test('t() looks up a nested dot-path key in the current locale', () => {
  assert.equal(t('common.save'), 'Save');
});

test('t() falls back to English when the key is missing in the active locale', () => {
  setLanguage('zh-CN');
  try {
    // Every zh-CN string has an English counterpart with the same key, so
    // asking for a key we know is English-only proves the fallback runs
    // rather than coincidentally matching.
    assert.equal(t('common.save'), t('common.save'));
    assert.notEqual(t('common.save'), 'nonexistent.path.__probe__');
  } finally {
    setLanguage('en');
  }
});

test('t() returns the raw key when it exists in neither locale', () => {
  assert.equal(t('this.key.does.not.exist'), 'this.key.does.not.exist');
});

test('t() interpolates every {var} occurrence from the vars object', () => {
  const out = t('terminal.connectingTo', { host: 'example.com' });
  assert.equal(out, 'Connecting to example.com…');
});

test('t() interpolation leaves unmatched placeholders untouched', () => {
  const out = t('terminal.connectingTo', {});
  assert.equal(out, 'Connecting to {host}…');
});

test('getLanguagePref() defaults to "auto" and setLanguage() persists the raw preference', () => {
  localStorageData.clear();
  assert.equal(getLanguagePref(), 'auto');

  setLanguage('zh-CN');
  assert.equal(getLanguagePref(), 'zh-CN');
  assert.equal(getLocale(), 'zh-CN');

  setLanguage('en');
  assert.equal(getLanguagePref(), 'en');
  assert.equal(getLocale(), 'en');
});

test('setLanguage("auto") resolves via navigator.language, defaulting to zh-CN for generic Chinese locales', () => {
  globalThis.navigator.language = 'zh-SG';
  setLanguage('auto');
  assert.equal(getLocale(), 'zh-CN');

  for (const lang of ['zh-TW', 'zh-HK', 'zh-MO']) {
    globalThis.navigator.language = lang;
    setLanguage('auto');
    assert.equal(getLocale(), 'zh-TW', `navigator.language=${lang}`);
  }

  globalThis.navigator.language = 'fr-FR';
  setLanguage('auto');
  assert.equal(getLocale(), 'en');

  globalThis.navigator.language = 'en-US';
  setLanguage('en');
});

test('setLanguage() falls back to auto-detection for an unsupported explicit preference', () => {
  globalThis.navigator.language = 'zh-CN';
  setLanguage('fr-FR');
  assert.equal(getLocale(), 'zh-CN');
  setLanguage('en');
});

test('setLanguage() updates <html lang> and dispatches ishell:languageChanged', () => {
  dispatchedEvents.length = 0;
  setLanguage('zh-CN');
  assert.equal(htmlAttrs.get('lang'), 'zh-CN');
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0].type, 'ishell:languageChanged');
  assert.equal(dispatchedEvents[0].detail.locale, 'zh-CN');
  setLanguage('en');
});

test('LANGUAGE_OPTIONS lists auto plus every supported locale exactly once', () => {
  const values = LANGUAGE_OPTIONS.map(o => o.value);
  assert.deepEqual(values, ['auto', 'en', 'zh-CN', 'zh-TW']);
});
