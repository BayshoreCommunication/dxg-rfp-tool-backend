import mongoose, { Document } from "mongoose";
export interface IProductVariant {
    name: string;
    options: string[];
    price?: number;
    sku?: string;
    stock?: number;
}
export interface IProductImage {
    url: string;
    alt?: string;
    isPrimary: boolean;
}
export interface IProduct extends Document {
    name: string;
    description: string;
    shortDescription?: string;
    price: number;
    compareAtPrice?: number;
    costPrice?: number;
    sku: string;
    barcode?: string;
    category: mongoose.Types.ObjectId;
    subCategory?: string;
    brand?: string;
    tags: string[];
    images: IProductImage[];
    variants?: IProductVariant[];
    stock: number;
    lowStockThreshold: number;
    trackInventory: boolean;
    allowBackorder: boolean;
    weight?: number;
    dimensions?: {
        length: number;
        width: number;
        height: number;
    };
    metaTitle?: string;
    metaDescription?: string;
    slug: string;
    status: "active" | "draft" | "archived";
    featured: boolean;
    averageRating: number;
    totalReviews: number;
    totalSales: number;
    createdAt: Date;
    updatedAt: Date;
    createdBy: mongoose.Types.ObjectId;
}
declare const Product: mongoose.Model<any, {}, {}, {}, any, any>;
export default Product;
//# sourceMappingURL=product.d.ts.map