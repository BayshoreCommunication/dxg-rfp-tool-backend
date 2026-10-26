/* Plans the one-time move of administrator accounts out of `users` into the
   dedicated `admins` collection.

   - move:  a pure admin account. The admin document keeps the same _id, so its
            organization membership, refresh sessions, support-ticket
            assignments and audit rows stay attached. The `users` row is removed.
   - split: the account was also used as a planner (it owns proposals or
            support tickets, signed in with Google, or was named explicitly).
            The `users` row stays a planner (role reset to customer, planner
            membership, version bumped so admin-era tokens go stale) and a new
            admin document with a new _id and its own membership is created
            from the same name, email and password hash.
   - skip:  an admin with this email already exists in `admins`; the operator
            resolves it by hand. */

export type AdminMigrationCandidate = {
  id: string;
  email: string;
  role: string;
  ownedProposals: number;
  requestedTickets: number;
  hasGoogleId: boolean;
};

export type AdminMigrationAction =
  | { kind: "move"; id: string; email: string; role: string }
  | { kind: "split"; id: string; email: string; role: string; reasons: string[] }
  | { kind: "skip"; id: string; email: string; reason: "admin_email_exists" };

const ADMIN_ROLES = new Set(["admin", "super_admin", "superadmin"]);

export const isLegacyAdminRole = (role?: string): boolean =>
  ADMIN_ROLES.has(String(role ?? "").toLowerCase().trim().replace(/[\s-]/g, "_"));

export const planAdminAccountMigration = (input: {
  candidates: AdminMigrationCandidate[];
  existingAdminEmails: ReadonlySet<string>;
  forceSplitEmails?: ReadonlySet<string>;
}): AdminMigrationAction[] =>
  input.candidates
    .filter((candidate) => isLegacyAdminRole(candidate.role))
    .map((candidate): AdminMigrationAction => {
      const email = candidate.email.toLowerCase().trim();
      if (input.existingAdminEmails.has(email)) {
        return { kind: "skip", id: candidate.id, email, reason: "admin_email_exists" };
      }
      const reasons = [
        ...(candidate.ownedProposals > 0 ? ["owns_proposals"] : []),
        ...(candidate.requestedTickets > 0 ? ["requested_support_tickets"] : []),
        ...(candidate.hasGoogleId ? ["google_sign_in"] : []),
        ...(input.forceSplitEmails?.has(email) ? ["requested_split"] : []),
      ];
      return reasons.length
        ? { kind: "split", id: candidate.id, email, role: candidate.role, reasons }
        : { kind: "move", id: candidate.id, email, role: candidate.role };
    });
