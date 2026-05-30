const el = () => document.getElementById('kb-toast');

export function showToast(msg, duration = 1600) {
  const t = el();
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), duration);
}
