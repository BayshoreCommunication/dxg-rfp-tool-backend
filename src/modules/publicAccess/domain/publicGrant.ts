export const PUBLIC_GRANT_PURPOSES = ["proposal:view", "vendor:submit"] as const;
export type PublicGrantPurpose = (typeof PUBLIC_GRANT_PURPOSES)[number];
