import { createGetAdminOverview } from "./application/getAdminOverview";
import {
  createDeleteAdminClient,
  createListAdminClients,
  createSetClientBlocked,
} from "./application/manageAdminClients";
import {
  createCreateAdminUser,
  createDeleteAdminUser,
  createListAdminUsers,
  createUpdateAdminUser,
} from "./application/manageAdminUsers";
import {
  createGetAdminSelfProfile,
  createUpdateAdminSelfProfile,
} from "./application/manageAdminSelfProfile";
import { mongoAdminClientRepository } from "./infrastructure/mongo/mongoAdminClientRepository";
import { mongoAdminUserRepository } from "./infrastructure/mongo/mongoAdminUserRepository";
import { mongoAdminSelfProfileRepository } from "./infrastructure/mongo/mongoAdminSelfProfileRepository";
import { spacesAdminAvatarStorage } from "./infrastructure/storage/spacesAdminAvatarStorage";
import { bcryptPasswordHasher } from "../../shared/security/bcryptPasswordHasher";
import { bcryptPasswordVerifier } from "../../shared/security/bcryptPasswordHasher";
import { mongoAdminOverviewReadRepository } from "./infrastructure/mongo/mongoAdminOverviewReadRepository";

export const getAdminOverviewReport = createGetAdminOverview(
  mongoAdminOverviewReadRepository,
);

export const listAdminClients = createListAdminClients(mongoAdminClientRepository);
export const setAdminClientBlocked = createSetClientBlocked(mongoAdminClientRepository);
export const deleteAdminClient = createDeleteAdminClient(mongoAdminClientRepository);
export const listAdministrativeUsers = createListAdminUsers(mongoAdminUserRepository);
export const createAdministrativeUser = createCreateAdminUser(mongoAdminUserRepository);
export const updateAdministrativeUser = createUpdateAdminUser(
  mongoAdminUserRepository,
  bcryptPasswordHasher,
);
export const deleteAdministrativeUser = createDeleteAdminUser(mongoAdminUserRepository);

export const getAdminSelfProfile = createGetAdminSelfProfile(
  mongoAdminSelfProfileRepository,
);
export const updateAdminSelfProfile = createUpdateAdminSelfProfile({
  repository: mongoAdminSelfProfileRepository,
  avatars: spacesAdminAvatarStorage,
  passwords: bcryptPasswordHasher,
  passwordVerifier: bcryptPasswordVerifier,
  timestamps: { nowMs: () => Date.now() },
  storageFolder: process.env.DO_FOLDER_NAME ?? "",
});
