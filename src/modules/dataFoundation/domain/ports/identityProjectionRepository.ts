export type IdentityProjectionInput = {
  organizationMongoId: string;
  userMongoId: string;
  correlationId: string;
  /* Supplied only where the caller already knows it. Without a name an absent
     organization is reported rather than invented, because the name is a
     NOT NULL business field and a placeholder would reach client documents. */
  organizationName?: string;
};

export type IdentityProjectionResult = {
  organizationId: string;
  userId: string;
  organizationCreated: boolean;
  userCreated: boolean;
};

export interface IdentityProjectionRepository {
  ensure(input: IdentityProjectionInput): Promise<IdentityProjectionResult>;
}
