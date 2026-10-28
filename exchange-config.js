// Self-hosted PHP + Postgres MusicXML exchange.
// Resolves to ./api relative to the current page (works for / and /Klavier/).
window.KlavierExchangeConfig = {
  apiBase: new URL("api", window.location.href.replace(/[^/]*$/, "")).href.replace(
    /\/$/,
    ""
  ),
};
