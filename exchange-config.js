// Optional publish token for seamless shared uploads (skips the GitHub issue step).
// Prefer a fine-grained PAT limited to this repository only.
// Warning: a Contents write token in the browser can modify repository files.
// The safer default is the issue-based publish Action (no token required).
// Usage:
//   window.KlavierExchangeConfig = { token: "YOUR_TOKEN", branch: "main" };
// or: localStorage.setItem("klavierxml-exchange-token", "YOUR_TOKEN");
window.KlavierExchangeConfig = {
  // branch: "main",
  // token: "",
};
