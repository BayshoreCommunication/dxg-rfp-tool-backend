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
  AK: "Alaska Time (AKT)",
  AL: "Central Time (CT)", AR: "Central Time (CT)", AZ: "Mountain Time (MT)",
  CA: "Pacific Time (PT)", CO: "Mountain Time (MT)",
  CT: "Eastern Time (ET)", DC: "Eastern Time (ET)", DE: "Eastern Time (ET)",
  FL: "Eastern Time (ET)", GA: "Eastern Time (ET)", HI: "Hawaii Time (HT)",
  ID: "Mountain Time (MT)", IL: "Central Time (CT)", IN: "Eastern Time (ET)",
  IA: "Central Time (CT)", KS: "Central Time (CT)", KY: "Eastern Time (ET)",
  LA: "Central Time (CT)", MA: "Eastern Time (ET)", MD: "Eastern Time (ET)",
  ME: "Eastern Time (ET)", MI: "Eastern Time (ET)", MN: "Central Time (CT)",
  MO: "Central Time (CT)", MS: "Central Time (CT)", MT: "Mountain Time (MT)",
  NC: "Eastern Time (ET)", ND: "Central Time (CT)", NE: "Central Time (CT)",
  NH: "Eastern Time (ET)", NJ: "Eastern Time (ET)", NM: "Mountain Time (MT)",
  NV: "Pacific Time (PT)", NY: "Eastern Time (ET)", OH: "Eastern Time (ET)",
  OK: "Central Time (CT)", OR: "Pacific Time (PT)", PA: "Eastern Time (ET)",
  RI: "Eastern Time (ET)", SC: "Eastern Time (ET)", SD: "Central Time (CT)",
  TN: "Central Time (CT)", TX: "Central Time (CT)", UT: "Mountain Time (MT)",
  VA: "Eastern Time (ET)", VT: "Eastern Time (ET)", WA: "Pacific Time (PT)",
  WI: "Central Time (CT)", WV: "Eastern Time (ET)", WY: "Mountain Time (MT)",
  OTHER: "Other / International",
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
  value.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");

export const resolveVenueLocation = (answer: string): ResolvedVenueLocation | null => {
  const parts = answer.split(",").map((part) => part.trim()).filter(Boolean);
  const cityPart = parts[0] ?? "";
  if (!cityPart) return null;

  const state = parts.length >= 2 ? (() => {
    const supplied = key(parts[1]);
    if (supplied.length === 2) return supplied.toUpperCase();
    return STATE_NAMES[supplied] ?? "OTHER";
  })() : EVENT_MARKET_STATES[key(cityPart)] ?? "";
  if (!STATE_TIME_ZONES[state]) return null;

  return {
    city: cleanCity(cityPart),
    state,
    timeZone: STATE_TIME_ZONES[state],
  };
};
