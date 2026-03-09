import mongoose, { Document } from "mongoose";
type AttendanceStatus = "present" | "absent";
export interface IAttendance extends Document {
    admissionId: mongoose.Types.ObjectId | string;
    studentId?: string;
    studentName: string;
    date: Date;
    status: AttendanceStatus;
    smsSent: boolean;
    smsSentAt?: Date;
    smsRecipients?: string[];
    notes?: string;
    markedBy: mongoose.Types.ObjectId | string;
    createdAt: Date;
    updatedAt: Date;
}
declare const Attendance: mongoose.Model<IAttendance, {}, {}, {}, mongoose.Document<unknown, {}, IAttendance, {}, {}> & IAttendance & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
export default Attendance;
//# sourceMappingURL=attendance.d.ts.map