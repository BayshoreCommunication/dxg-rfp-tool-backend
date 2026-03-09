import mongoose, { Document } from "mongoose";
type FeeStatus = "pending" | "paid" | "overdue" | "partial";
type PaymentMethod = "cash" | "bank" | "mobile_banking" | "other";
export interface IFee extends Document {
    admissionId: mongoose.Types.ObjectId | string;
    studentId?: string;
    studentName: string;
    monthlyFee: number;
    amountPaid: number;
    amountDue: number;
    status: FeeStatus;
    paymentDate?: Date;
    dueDate: Date;
    paymentMethod?: PaymentMethod;
    transactionId?: string;
    paymentSmsSent: boolean;
    paymentSmsSentAt?: Date;
    reminderSmsSent: boolean;
    reminderSmsSentAt?: Date;
    overdueSmsSent: boolean;
    overdueSmsSentAt?: Date;
    month: number;
    year: number;
    notes?: string;
    createdBy: mongoose.Types.ObjectId | string;
    updatedBy?: mongoose.Types.ObjectId | string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}
declare const Fee: mongoose.Model<IFee, {}, {}, {}, mongoose.Document<unknown, {}, IFee, {}, {}> & IFee & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
export default Fee;
//# sourceMappingURL=fee.d.ts.map