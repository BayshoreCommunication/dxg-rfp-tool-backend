import mongoose, { Document } from "mongoose";
export interface IOrderItem {
    product: mongoose.Types.ObjectId;
    productName: string;
    productImage?: string;
    sku: string;
    variant?: string;
    quantity: number;
    price: number;
    discount: number;
    total: number;
}
export interface IShippingAddress {
    fullName: string;
    phone: string;
    email?: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
}
export interface IPaymentInfo {
    method: "cash_on_delivery" | "card" | "bank_transfer" | "mobile_payment" | "paypal" | "stripe";
    transactionId?: string;
    status: "pending" | "completed" | "failed" | "refunded";
    paidAt?: Date;
}
export interface IOrder extends Document {
    orderNumber: string;
    customer: mongoose.Types.ObjectId;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    items: IOrderItem[];
    subtotal: number;
    discount: number;
    discountCode?: string;
    tax: number;
    taxRate: number;
    shippingCost: number;
    total: number;
    shippingAddress: IShippingAddress;
    billingAddress?: IShippingAddress;
    shippingMethod: string;
    trackingNumber?: string;
    paymentInfo: IPaymentInfo;
    orderStatus: "pending" | "processing" | "shipped" | "delivered" | "cancelled" | "refunded";
    fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
    customerNote?: string;
    internalNote?: string;
    orderDate: Date;
    processedAt?: Date;
    shippedAt?: Date;
    deliveredAt?: Date;
    cancelledAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
declare const Order: mongoose.Model<any, {}, {}, {}, any, any>;
export default Order;
//# sourceMappingURL=order.d.ts.map