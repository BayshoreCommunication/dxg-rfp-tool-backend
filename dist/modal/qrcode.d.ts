import mongoose, { Document } from "mongoose";
type QRCodeType = "student" | "exam" | "admission" | "custom" | "url" | "text";
export interface IQRCode extends Document {
    name: string;
    type: QRCodeType;
    content: string;
    description?: string;
    studentId?: string;
    admissionId?: mongoose.Types.ObjectId | string;
    examId?: mongoose.Types.ObjectId | string;
    expiresAt?: Date;
    isActive: boolean;
    metadata?: Record<string, unknown>;
    createdBy: mongoose.Types.ObjectId | string;
    updatedBy?: mongoose.Types.ObjectId | string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}
declare const QRCode: mongoose.Model<IQRCode, {}, {}, {}, mongoose.Document<unknown, {}, IQRCode, {}, {}> & IQRCode & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
export default QRCode;
//# sourceMappingURL=qrcode.d.ts.map