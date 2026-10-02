// Optional: set a fine-grained GitHub PAT (Contents: Read and write on this
// repository only) so uploads are published into exchange/ for every visitor.
// Without a token, uploads stay on this device only.
//
// Prefer adding repository secret EXCHANGE_TOKEN and deploying via GitHub
// Actions on main (the Pages workflow injects it). Or set locally:
//   window.KlavierExchangeConfig = { token: "YOUR_TOKEN", branch: "main" };
//   localStorage.setItem("klavierxml-exchange-token", "YOUR_TOKEN");
window.KlavierExchangeConfig = {
  // branch: "main",
  // token: "",
};
