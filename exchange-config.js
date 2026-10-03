// Supabase-backed MusicXML exchange.
//
// Setup:
// 1. Create a free project at https://supabase.com
// 2. Run exchange/supabase-setup.sql in the Supabase SQL editor
// 3. Project Settings → API → copy Project URL and anon public key below
//
// Until these are set, the library still shows built-in scores; uploads stay disabled.
window.KlavierExchangeConfig = {
  supabaseUrl: "",
  supabaseAnonKey: "",
};
