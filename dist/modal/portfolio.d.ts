import mongoose, { Document } from "mongoose";
export interface IPortfolio extends Document {
    appTitle: string;
    appLogo: string;
    appDescription?: string;
    appTagline?: string;
    favicon?: string;
    primaryColor?: string;
    secondaryColor?: string;
    accentColor?: string;
    email?: string;
    phone?: string;
    address?: string;
    website?: string;
    socialMedia?: {
        facebook?: string;
        twitter?: string;
        instagram?: string;
        linkedin?: string;
        youtube?: string;
    };
    metaKeywords?: string;
    metaDescription?: string;
    copyrightText?: string;
    createdBy: mongoose.Types.ObjectId | string;
    updatedBy?: mongoose.Types.ObjectId | string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}
declare const Portfolio: mongoose.Model<IPortfolio, {}, {}, {}, mongoose.Document<unknown, {}, IPortfolio, {}, {}> & IPortfolio & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
export default Portfolio;
//# sourceMappingURL=portfolio.d.ts.map