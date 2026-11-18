// Små forbedringer uten inline-skript (CSP tillater kun skript fra /static).
document.addEventListener('submit', (e) => {
  const msg = e.target.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) e.preventDefault();
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-print]');
  if (el) { e.preventDefault(); window.print(); }
  const all = e.target.closest('[data-check-all]');
  if (all) {
    e.preventDefault();
    const box = document.querySelectorAll(`input[name="${all.dataset.checkAll}"]${all.dataset.filter ? `[data-group="${all.dataset.filter}"]` : ''}`);
    const anyOff = [...box].some((b) => !b.checked);
    box.forEach((b) => { b.checked = anyOff; });
  }
});
// Auto-send skjema når et felt med data-autosubmit endres
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-autosubmit]')) e.target.form.submit();
});
