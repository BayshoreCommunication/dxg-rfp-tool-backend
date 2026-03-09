import mongoose, { Document } from "mongoose";
type ExamStatus = "scheduled" | "completed" | "cancelled";
type ExamType = "quiz" | "midterm" | "final" | "assignment" | "other";
export interface IExam extends Document {
    examName: string;
    examType: ExamType;
    subject: string;
    class: string;
    batchName?: string;
    description?: string;
    examDate: Date;
    examTime: string;
    duration?: number;
    status: ExamStatus;
    scheduleSmsSent: boolean;
    scheduleSmsSentAt?: Date;
    resultSmsSent: boolean;
    resultSmsSentAt?: Date;
    createdBy: mongoose.Types.ObjectId | string;
    updatedBy?: mongoose.Types.ObjectId | string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}
export interface IExamResult extends Document {
    examId: mongoose.Types.ObjectId | string;
    examName?: string;
    admissionId: mongoose.Types.ObjectId | string;
    studentId?: string;
    studentName: string;
    marks: number;
    totalMarks: number;
    grade?: string;
    percentage: number;
    present: boolean;
    absentSmsSent: boolean;
    absentSmsSentAt?: Date;
    resultSmsSent: boolean;
    resultSmsSentAt?: Date;
    notes?: string;
    createdBy: mongoose.Types.ObjectId | string;
    updatedBy?: mongoose.Types.ObjectId | string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}
declare const Exam: mongoose.Model<IExam, {}, {}, {}, mongoose.Document<unknown, {}, IExam, {}, {}> & IExam & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
declare const ExamResult: mongoose.Model<IExamResult, {}, {}, {}, mongoose.Document<unknown, {}, IExamResult, {}, {}> & IExamResult & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
export default Exam;
export { ExamResult };
//# sourceMappingURL=exam.d.ts.map