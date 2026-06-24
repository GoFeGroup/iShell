import { t } from './i18n.js';

// Modal-based stand-in for window.confirm(), which this app's webview does
// not reliably support (see ai-sidebar.js's inline-confirm comment for the
// same root cause). For confirmations tied to a visible list row, prefer an
// inline confirm/cancel swap instead — this is for one-off actions (e.g. a
// button click or context-menu item) that have no row to swap in place.
export function confirmDialog(message, { okLabel, cancelLabel, danger = true } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
<div class="modal" style="width:380px;">
  <div class="modal-body">${escHtml(message)}</div>
  <div class="modal-footer">
    <button class="btn btn-secondary" id="cd-cancel" type="button">${escHtml(cancelLabel || t('common.cancel'))}</button>
    <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cd-ok" type="button">${escHtml(okLabel || t('common.delete'))}</button>
  </div>
</div>`;

    const finish = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('#cd-cancel').addEventListener('click', () => finish(false));
    overlay.querySelector('#cd-ok').addEventListener('click', () => finish(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });

    document.getElementById('modal-root').appendChild(overlay);
    overlay.querySelector('#cd-ok').focus();
  });
}

// Modal-based stand-in for window.prompt(), same rationale as confirmDialog
// above. Resolves to the entered text, or null if cancelled.
export function promptDialog(message, defaultValue = '', { okLabel, cancelLabel } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
<div class="modal" style="width:380px;">
  <div class="modal-body">
    <div style="margin-bottom:10px;">${escHtml(message)}</div>
    <input class="input" id="pd-input" style="width:100%;" />
  </div>
  <div class="modal-footer">
    <button class="btn btn-secondary" id="pd-cancel" type="button">${escHtml(cancelLabel || t('common.cancel'))}</button>
    <button class="btn btn-primary" id="pd-ok" type="button">${escHtml(okLabel || t('common.save'))}</button>
  </div>
</div>`;

    const input = overlay.querySelector('#pd-input');
    input.value = defaultValue;

    const finish = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('#pd-cancel').addEventListener('click', () => finish(null));
    overlay.querySelector('#pd-ok').addEventListener('click', () => finish(input.value));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') finish(input.value);
      if (e.key === 'Escape') finish(null);
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });

    document.getElementById('modal-root').appendChild(overlay);
    input.focus();
    input.select();
  });
}

function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
