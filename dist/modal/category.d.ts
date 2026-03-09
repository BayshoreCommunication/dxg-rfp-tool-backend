import mongoose, { Document } from "mongoose";
export interface ICategory extends Document {
    name: string;
    slug: string;
    description?: string;
    image?: string;
    parent?: mongoose.Types.ObjectId;
    status: "active" | "inactive";
    sortOrder: number;
    metaTitle?: string;
    metaDescription?: string;
    productsCount: number;
    createdAt: Date;
    updatedAt: Date;
}
declare const Category: mongoose.Model<any, {}, {}, {}, any, any>;
export default Category;
//# sourceMappingURL=category.d.ts.map