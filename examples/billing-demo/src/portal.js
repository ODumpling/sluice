// Customer billing portal: a small frontend over the JSON API, so
// `browser` steps can drive the same flows a customer would.
export function portalHtml(subscriptionId) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Billing portal</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #1d1b1a; }
  .card { border: 1px solid #e3dfdb; border-radius: 10px; padding: 1rem 1.25rem; }
  button { font: inherit; padding: .5rem 1rem; border-radius: 8px; border: 1px solid #c22a3a; background: #fff; color: #c22a3a; cursor: pointer; }
  #message { min-height: 1.5em; }
</style>
</head>
<body>
<h1>Your subscription</h1>
<div class="card">
  <p id="plan">Loading…</p>
  <p id="status"></p>
  <p id="period"></p>
  <button id="cancel" hidden>Cancel subscription</button>
</div>
<p id="message" role="status"></p>
<script>
  const id = ${JSON.stringify(String(subscriptionId))};
  const $ = (s) => document.querySelector(s);
  const day = (iso) => iso.slice(0, 10);
  function render(s) {
    $('#plan').textContent = 'Plan: ' + s.plan;
    $('#status').textContent = 'Status: ' + s.status;
    $('#period').textContent =
      s.status === 'canceled' ? 'Ended ' + day(s.canceled_at || s.current_period_end)
      : s.cancel_at ? 'Cancels on ' + day(s.cancel_at)
      : 'Renews on ' + day(s.current_period_end);
    $('#cancel').hidden = s.status !== 'active' || !!s.cancel_at;
  }
  async function load() {
    const res = await fetch('/subscriptions/' + id);
    const body = await res.json();
    if (!res.ok) { $('#plan').textContent = body.error; return; }
    render(body);
  }
  $('#cancel').addEventListener('click', async () => {
    const res = await fetch('/subscriptions/' + id + '/cancel', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) { $('#message').textContent = 'Could not cancel: ' + body.error; return; }
    render(body);
    $('#message').textContent = 'Cancellation confirmed';
  });
  load();
</script>
</body>
</html>
`;
}
