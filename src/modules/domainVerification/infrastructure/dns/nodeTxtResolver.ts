import { Resolver } from "node:dns/promises";
import type { TxtLookup, TxtResolver } from "../../application/manageDomains";

// Answers that definitively say "no such TXT record". Anything else (SERVFAIL, timeout,
// refused) is an error and never un-verifies a domain.
const DEFINITIVE_ABSENCE = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

export const createNodeTxtResolver = (options: { timeoutMs?: number; servers?: string[] } = {}): TxtResolver => ({
  async resolve(domain): Promise<TxtLookup> {
    const resolver = new Resolver({ timeout: options.timeoutMs ?? 5_000, tries: 2 });
    if (options.servers?.length) resolver.setServers(options.servers);
    try {
      const records = await resolver.resolveTxt(domain);
      // A long TXT value arrives split into 255-byte chunks.
      return { kind: "records", values: records.map((chunks) => chunks.join("")) };
    } catch (error) {
      const code = String((error as { code?: string })?.code ?? "UNKNOWN");
      return DEFINITIVE_ABSENCE.has(code) ? { kind: "none" } : { kind: "error", code };
    }
  },
});

export const nodeTxtResolver = createNodeTxtResolver({
  servers: (process.env.DOMAIN_VERIFICATION_DNS_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
});
