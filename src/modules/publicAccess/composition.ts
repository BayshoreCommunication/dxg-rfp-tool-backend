import { createPublicAccessManager } from "./application/managePublicAccess";
import { mongoPublicAccessRepository } from "./infrastructure/mongoPublicAccessRepository";
export const publicAccess = createPublicAccessManager(mongoPublicAccessRepository);
