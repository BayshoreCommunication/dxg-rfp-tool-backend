// What an OpenID Connect provider publishes at /.well-known/openid-configuration (the parts we use).
export type ProviderMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

// Short-lived, single-use records for the federated sign-in round trip.
export type SsoStateStore = {
  put(namespace: string, key: string, value: unknown, ttlMs: number): Promise<void>;
  /** Returns the value once and deletes it; later calls get null. */
  take<T>(namespace: string, key: string): Promise<T | null>;
};
