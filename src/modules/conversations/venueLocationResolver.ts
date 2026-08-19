export type ResolvedVenueLocation = {
  city: string;
  state: string;
  timeZone: string;
};

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

export const STATE_TIME_ZONES: Record<string, string> = {
  AK: "America/Anchorage",
  AL: "America/Chicago", AR: "America/Chicago", AZ: "America/Phoenix",
  CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York", DC: "America/New_York", DE: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  IA: "America/Chicago", ID: "America/Boise", IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis", KS: "America/Chicago",
  KY: "America/Kentucky/Louisville", LA: "America/Chicago",
  MA: "America/New_York", MD: "America/New_York", ME: "America/New_York",
  MI: "America/Detroit", MN: "America/Chicago", MO: "America/Chicago",
  MS: "America/Chicago", MT: "America/Denver", NC: "America/New_York",
  ND: "America/Chicago", NE: "America/Chicago", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NV: "America/Los_Angeles",
  NY: "America/New_York", OH: "America/New_York", OK: "America/Chicago",
  OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago",
  TX: "America/Chicago", UT: "America/Denver", VA: "America/New_York",
  VT: "America/New_York", WA: "America/Los_Angeles", WI: "America/Chicago",
  WV: "America/New_York", WY: "America/Denver",
  OTHER: "Other / International",
};

const CITY_TIME_ZONES: Record<string, string> = {
  "pensacola|FL": "America/Chicago", "panama city|FL": "America/Chicago",
  "miami|FL": "America/New_York", "orlando|FL": "America/New_York",
  "tampa|FL": "America/New_York", "knoxville|TN": "America/New_York",
  "chattanooga|TN": "America/New_York", "el paso|TX": "America/Denver",
  "boise|ID": "America/Boise", "coeur dalene|ID": "America/Los_Angeles",
  "ontario|OR": "America/Boise", "portland|OR": "America/Los_Angeles",
  "anchorage|AK": "America/Anchorage", "adak|AK": "America/Adak",
  "honolulu|HI": "Pacific/Honolulu", "paris|OTHER": "Europe/Paris",
  "london|OTHER": "Europe/London", "berlin|OTHER": "Europe/Berlin",
  "amsterdam|OTHER": "Europe/Amsterdam", "madrid|OTHER": "Europe/Madrid",
  "rome|OTHER": "Europe/Rome", "toronto|OTHER": "America/Toronto",
  "montreal|OTHER": "America/Toronto", "vancouver|OTHER": "America/Vancouver",
  "calgary|OTHER": "America/Edmonton", "mexico city|OTHER": "America/Mexico_City",
  "sao paulo|OTHER": "America/Sao_Paulo",
  "buenos aires|OTHER": "America/Argentina/Buenos_Aires",
  "dubai|OTHER": "Asia/Dubai", "dhaka|OTHER": "Asia/Dhaka",
  "new delhi|OTHER": "Asia/Kolkata", "delhi|OTHER": "Asia/Kolkata",
  "mumbai|OTHER": "Asia/Kolkata", "singapore|OTHER": "Asia/Singapore",
  "tokyo|OTHER": "Asia/Tokyo", "sydney|OTHER": "Australia/Sydney",
  "melbourne|OTHER": "Australia/Melbourne",
};

// Unique, common event markets. Ambiguous names such as Portland and
// Springfield deliberately require "City, ST" rather than a guess.
const EVENT_MARKET_STATES: Record<string, string> = {
  atlanta: "GA", austin: "TX", baltimore: "MD", boston: "MA", charlotte: "NC",
  chicago: "IL", cincinnati: "OH", cleveland: "OH", columbus: "OH", dallas: "TX",
  denver: "CO", detroit: "MI", honolulu: "HI", houston: "TX", indianapolis: "IN",
  "kansas city": "MO", "las vegas": "NV", "los angeles": "CA", louisville: "KY",
  memphis: "TN", miami: "FL", milwaukee: "WI", minneapolis: "MN", nashville: "TN",
  "new orleans": "LA", "new york": "NY", oakland: "CA", orlando: "FL",
  philadelphia: "PA", phoenix: "AZ", pittsburgh: "PA", raleigh: "NC",
  sacramento: "CA", "salt lake city": "UT", "san antonio": "TX",
  "san diego": "CA", "san francisco": "CA", "san jose": "CA", seattle: "WA",
  "st louis": "MO", tampa: "FL", tucson: "AZ", "washington dc": "DC",
};

const cleanCity = (value: string): string =>
  value.trim().replace(/\s+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const key = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ");

export const resolveVenueLocation = (answer: string): ResolvedVenueLocation | null => {
  const parts = answer.split(",").map((part) => part.trim()).filter(Boolean);
  const cityPart = parts[0] ?? "";
  if (!cityPart) return null;

  const state = parts.length >= 2 ? (() => {
    const supplied = key(parts[1]);
    if (supplied.length === 2) return supplied.toUpperCase();
    return STATE_NAMES[supplied] ?? "OTHER";
  })() : EVENT_MARKET_STATES[key(cityPart)] ?? "";
  const timeZone = CITY_TIME_ZONES[`${key(cityPart)}|${state}`] ?? STATE_TIME_ZONES[state];
  if (!timeZone) return null;

  return {
    city: cleanCity(cityPart),
    state,
    timeZone,
  };
};
