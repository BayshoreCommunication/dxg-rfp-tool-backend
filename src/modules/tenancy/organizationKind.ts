// An organization's kind as the schema means it (modal/organizationModel.ts: default "customer").
// Documents written before the field existed have no stored `kind`, and a lean or raw-driver read
// does not apply the schema default, so code that reads organizations that way asks here. A stored
// value, whatever it is, is returned as it is. No imports: safe to load from any script.
export const organizationKindOf = (organization: object | null | undefined): string => {
  const kind = (organization as { kind?: unknown } | null | undefined)?.kind;
  return kind === undefined || kind === null ? "customer" : String(kind);
};
