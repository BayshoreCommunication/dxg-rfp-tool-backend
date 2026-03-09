import mongoose, { Document } from "mongoose";
type AdmissionStatus = "active" | "inactive" | "completed";
export interface IAdmission extends Document {
    studentName: string;
    fatherName: string;
    motherName: string;
    schoolName: string;
    fatherMobile: string;
    motherMobile?: string;
    studentMobile?: string;
    class: string;
    subjects: string[];
    batchName: string;
    batchTime: string;
    admissionDate: Date;
    monthlyFee: number;
    studentSignature?: string;
    directorSignature?: string;
    studentId?: string;
    status: AdmissionStatus;
    notes?: string;
    alarmMobile?: string[];
    smsHistory?: string[];
    emailHistory?: string[];
    createdBy: mongoose.Types.ObjectId | string;
    updatedBy?: mongoose.Types.ObjectId | string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}
declare const Admission: mongoose.Model<IAdmission, {}, {}, {}, mongoose.Document<unknown, {}, IAdmission, {}, {}> & IAdmission & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
export default Admission;
//# sourceMappingURL=admission.d.ts.map