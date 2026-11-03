/* ORG-305 domain rules: normalising what an Admin types, and the public mail
   providers that can never be verified (anyone can get an address there, so a
   verified gmail.com would let every Gmail user request access). */

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com",
  "yahoo.com", "ymail.com", "rocketmail.com",
  "aol.com", "aim.com",
  "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "protonmail.ch", "pm.me",
  "gmx.com", "gmx.net", "gmx.de", "web.de", "mail.com", "email.com",
  "zoho.com", "zohomail.com",
  "yandex.com", "yandex.ru", "mail.ru", "inbox.ru", "list.ru", "bk.ru",
  "qq.com", "163.com", "126.com", "yeah.net", "sina.com", "sohu.com", "naver.com", "daum.net",
  "fastmail.com", "fastmail.fm", "hey.com", "tutanota.com", "tuta.io", "hushmail.com",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "cox.net", "earthlink.net",
  "btinternet.com", "sky.com", "virginmedia.com", "orange.fr", "free.fr", "laposte.net", "libero.it",
  "rediffmail.com", "mailinator.com", "duck.com",
]);

// Country variants of the big providers: yahoo.co.uk, hotmail.fr, outlook.de, live.com.au, ...
const PUBLIC_PROVIDER_FAMILY = /^(?:yahoo|hotmail|outlook|live|gmx|yandex|aol|windowslive)\.(?:[a-z]{2,3}|com?\.[a-z]{2}|co\.[a-z]{2})$/;

export const normalizeDomain = (input: unknown): string | null => {
  if (typeof input !== "string") return null;
  let value = input.trim().toLowerCase();
  if (value.includes("@")) value = value.slice(value.lastIndexOf("@") + 1);
  value = value.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (value.startsWith("www.")) value = value.slice(4);
  return DOMAIN_PATTERN.test(value) ? value : null;
};

export const extraPublicMailDomains = (value = process.env.PUBLIC_MAIL_DOMAINS_EXTRA): string[] =>
  (value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);

/** True for a public provider or any subdomain of one. */
export const isPublicMailDomain = (domain: string, extra: string[] = extraPublicMailDomains()): boolean => {
  const labels = domain.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    if (PUBLIC_MAIL_DOMAINS.has(candidate) || extra.includes(candidate) || PUBLIC_PROVIDER_FAMILY.test(candidate)) return true;
  }
  return false;
};

export const TXT_RECORD_PREFIX = "rfpilot-domain-verification=";
export const txtRecordValue = (token: string) => `${TXT_RECORD_PREFIX}${token}`;

/* DXG question Q7 is open: DNS TXT only, or also "an Admin with a verified email
   at that domain"? The spec's behaviour, DNS TXT only, is the default.
   DOMAIN_VERIFICATION_METHODS=dns_txt,admin_email turns the second on. */
export const allowedVerificationMethods = (value = process.env.DOMAIN_VERIFICATION_METHODS) => {
  const methods = new Set((value ?? "dns_txt").split(",").map((entry) => entry.trim().toLowerCase()));
  return { dnsTxt: true, adminEmail: methods.has("admin_email") };
};
