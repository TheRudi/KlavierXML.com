// Optional publish token for seamless shared uploads (no GitHub issue step).
// Create a fine-grained PAT with Contents: Read and write on this repository only,
// then either:
//   1) set window.KlavierExchangeConfig below, or
//   2) run localStorage.setItem('klavierxml-exchange-token', 'YOUR_TOKEN') in the browser.
// Never use a classic PAT with broad access. Rotate if exposed.
window.KlavierExchangeConfig = {
  // branch: "main",
  // token: "",
};
