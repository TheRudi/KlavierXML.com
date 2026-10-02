// Upload publish credentials for the shared MusicXML exchange.
//
// GitHub Pages is fine for hosting this site. Browser uploads need a
// long-lived fine-grained PAT so they do not expire every hour:
//   GitHub → Settings → Developer settings → Fine-grained tokens
//   Resource owner: TheRudi
//   Repository access: Only TheRudi/KlavierXML.com
//   Permissions → Repository → Contents: Read and write
// Then set token below (or repo secret EXCHANGE_TOKEN for Actions inject).
window.KlavierExchangeConfig = {
  "token": "ghs_1210556_eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRobmQiLCJjdHgiOiI0YVZZbnVEZ3EwVGZTM3pjSWs1MWNPNFJ3Zk9WcFk0SENRRXZ1UHd2NVNuV1h0OGlucWIwc25KWmFmcTRHUWciLCJleHAiOjE3OTA5ODgzMDcsImlhdCI6MTc5MDk4NDcwNywiaXNzIjoiZ2l0aHViIiwianRpIjoiOWU4YjE5ZDItZTg0OS00OTc3LTk2N2ItYzRkZDZhYWUxNmI4IiwidmVyIjozfQ.UxsTmwpV63__gtKQsZgj77YD4rAajGMEjzziw-nzTDjEdvgl8a5NwG5EyUzRuYxkxRaIa9rgSomg8ohf11PT5A",
  "branch": "cursor/klavierxml-website-4be4"
};
