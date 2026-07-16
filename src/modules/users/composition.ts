import {
  createDeleteUser,
  createGetPrimaryAdmin,
  createGetUser,
  createListUsers,
  createUpdatePrimaryAdmin,
  createUpdateUserProfile,
} from "./application/manageUserAccounts";
import { mongoUserAccountRepository } from "./infrastructure/mongo/mongoUserAccountRepository";
import { bcryptPasswordHasher } from "../../shared/security/bcryptPasswordHasher";

export const listUserAccounts = createListUsers(mongoUserAccountRepository);
export const getUserAccount = createGetUser(mongoUserAccountRepository);
export const getPrimaryAdminAccount = createGetPrimaryAdmin(mongoUserAccountRepository);
export const updateUserAccount = createUpdateUserProfile(mongoUserAccountRepository, bcryptPasswordHasher);
export const updatePrimaryAdminAccount = createUpdatePrimaryAdmin(mongoUserAccountRepository, bcryptPasswordHasher);
export const deleteUserAccount = createDeleteUser(mongoUserAccountRepository);
