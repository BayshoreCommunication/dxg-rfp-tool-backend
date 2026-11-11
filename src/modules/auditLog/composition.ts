import { createAuditLog } from "./application/readAuditLog";
import { mongoAuditEventReader } from "./infrastructure/mongoAuditEventReader";

export const auditLog = createAuditLog({ events: mongoAuditEventReader });
