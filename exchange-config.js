// Optional: configure a fine-grained GitHub PAT (Contents: Read and write on
// this repository only) to publish uploads into exchange/shared-manifest.json
// for every visitor. Without a token, uploads stay on this device only.
//
// window.KlavierExchangeConfig = { token: "YOUR_TOKEN", branch: "main" };
// or: localStorage.setItem("klavierxml-exchange-token", "YOUR_TOKEN");
//
// Warning: a browser-exposed write token can modify repository files.
window.KlavierExchangeConfig = {
  // branch: "main",
  // token: "",
};
