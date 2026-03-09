import mongoose, { Document } from "mongoose";
type SMSStatus = "pending" | "sent" | "failed" | "delivered";
type SMSType = "single" | "bulk" | "exam" | "fee" | "attendance" | "custom";
export interface ISMS extends Document {
    type: SMSType;
    message: string;
    recipients: Array<{
        mobileNumber: string;
        name?: string;
        studentId?: string;
        admissionId?: mongoose.Types.ObjectId | string;
        status: SMSStatus;
        sentAt?: Date;
        deliveredAt?: Date;
        error?: string;
    }>;
    senderId: string;
    apiKey?: string;
    examId?: mongoose.Types.ObjectId | string;
    feeId?: mongoose.Types.ObjectId | string;
    admissionId?: mongoose.Types.ObjectId | string;
    totalRecipients: number;
    sentCount: number;
    failedCount: number;
    deliveredCount: number;
    status: SMSStatus;
    metadata?: Record<string, unknown>;
    createdBy: mongoose.Types.ObjectId | string;
    updatedBy?: mongoose.Types.ObjectId | string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}
declare const SMS: mongoose.Model<ISMS, {}, {}, {}, mongoose.Document<unknown, {}, ISMS, {}, {}> & ISMS & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
export default SMS;
//# sourceMappingURL=sms.d.ts.map