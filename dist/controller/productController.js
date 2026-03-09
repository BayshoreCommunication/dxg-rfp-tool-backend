"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCategories = exports.deleteProduct = exports.updateProduct = exports.createProduct = exports.getProduct = exports.getProducts = void 0;
const fs_1 = __importDefault(require("fs"));
const category_1 = __importDefault(require("../modal/category"));
const product_1 = __importDefault(require("../modal/product"));
const imageProcessor_1 = require("../utils/imageProcessor");
const uploadToImgBB_1 = require("../utils/uploadToImgBB");
// Get all products with pagination and filters
const getProducts = async (req, res) => {
    try {
        const { page = 1, limit = 20, status, search, sortBy = "createdAt", sortOrder = "desc", featured, minPrice, maxPrice, category, } = req.query;
        const query = {};
        // Filter by status
        if (status) {
            query.status = status;
        }
        // Filter by category
        if (category) {
            // Find category by slug first to get the correct title
            const categoryDoc = await category_1.default.findOne({ slug: category });
            if (categoryDoc) {
                query.category = categoryDoc.title;
            }
            else {
                // Fallback to regex search on category string in Product
                query.category = { $regex: category, $options: "i" };
            }
        }
        // Filter by badges
        if (req.query.badges) {
            const badgeFilter = req.query.badges;
            // Support multiple badges? For now frontend sends one.
            query.badges = badgeFilter;
        }
        // Filter by featured
        if (featured !== undefined) {
            query.featured = featured === "true";
        }
        // Price range filter
        if (minPrice || maxPrice) {
            query.price = {};
            if (minPrice)
                query.price.$gte = Number(minPrice);
            if (maxPrice)
                query.price.$lte = Number(maxPrice);
        }
        // Search
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: "i" } },
                { description: { $regex: search, $options: "i" } },
                { sku: { $regex: search, $options: "i" } },
                { tags: { $in: [new RegExp(search, "i")] } },
                { category: { $regex: search, $options: "i" } },
            ];
        }
        const skip = (Number(page) - 1) * Number(limit);
        const sort = {};
        sort[sortBy] = sortOrder === "asc" ? 1 : -1;
        const products = await product_1.default.find(query)
            .populate("createdBy", "name email")
            .sort(sort)
            .limit(Number(limit))
            .skip(skip);
        const total = await product_1.default.countDocuments(query);
        // Convert product images to WebP format
        const productsWithWebP = await Promise.all(products.map(async (product) => {
            const productObj = product.toObject();
            if (productObj.images && productObj.images.length > 0) {
                productObj.images = await (0, imageProcessor_1.processProductImagesToWebP)(productObj.images, 85);
            }
            return productObj;
        }));
        res.status(200).json({
            success: true,
            data: productsWithWebP,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit)),
            },
        });
    }
    catch (error) {
        console.error("Error fetching products:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching products",
            error: error.message,
        });
    }
};
exports.getProducts = getProducts;
// Get single product by ID or slug
const getProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { slug: id };
        const product = await product_1.default.findOne(query)
            .populate("createdBy", "name email");
        if (!product) {
            return res.status(404).json({
                success: false,
                message: "Product not found",
            });
        }
        // Convert product images to WebP format
        const productObj = product.toObject();
        if (productObj.images && productObj.images.length > 0) {
            productObj.images = await (0, imageProcessor_1.processProductImagesToWebP)(productObj.images, 85);
        }
        return res.status(200).json({
            success: true,
            data: productObj,
        });
    }
    catch (error) {
        console.error("Error fetching product:", error);
        return res.status(500).json({
            success: false,
            message: "Error fetching product",
            error: error.message,
        });
    }
};
exports.getProduct = getProduct;
// Create new product
const createProduct = async (req, res) => {
    try {
        console.log("Create Product Request Body:", req.body);
        console.log("Create Product Request Files:", req.files);
        const files = req.files;
        const images = [];
        // Separate main product images from variant images
        const mainImages = files?.filter(file => file.fieldname === 'images') || [];
        // Upload main product images to ImgBB
        if (mainImages.length > 0) {
            for (const file of mainImages) {
                try {
                    console.log(`Uploading file: ${file.path}`);
                    const imageUrl = await (0, uploadToImgBB_1.uploadToImgBB)(file.path);
                    console.log(`Uploaded successfully: ${imageUrl}`);
                    images.push({
                        url: imageUrl,
                        isPrimary: images.length === 0,
                    });
                    fs_1.default.unlinkSync(file.path);
                }
                catch (uploadError) {
                    console.error("Image upload failed:", uploadError);
                    if (fs_1.default.existsSync(file.path))
                        fs_1.default.unlinkSync(file.path);
                    throw new Error(`Failed to upload image: ${uploadError.message}`);
                }
            }
        }
        const productData = {
            ...req.body,
            images,
            createdBy: req.user?.userId,
        };
        // Handle color variants
        if (req.body.colorVariants) {
            try {
                const colorVariants = JSON.parse(req.body.colorVariants);
                const processedColorVariants = [];
                for (let i = 0; i < colorVariants.length; i++) {
                    const variant = colorVariants[i];
                    const variantImages = [];
                    // Get files for this color variant
                    const variantFiles = files?.filter(file => file.fieldname === `colorVariant_${i}_images`) || [];
                    // Upload color variant images
                    for (const file of variantFiles) {
                        try {
                            const imageUrl = await (0, uploadToImgBB_1.uploadToImgBB)(file.path);
                            variantImages.push(imageUrl);
                            fs_1.default.unlinkSync(file.path);
                        }
                        catch (uploadError) {
                            console.error("Color variant image upload failed:", uploadError);
                            if (fs_1.default.existsSync(file.path))
                                fs_1.default.unlinkSync(file.path);
                        }
                    }
                    processedColorVariants.push({
                        color: variant.color,
                        colorCode: variant.colorCode,
                        images: variantImages,
                    });
                }
                productData.colorVariants = processedColorVariants;
            }
            catch (error) {
                console.error("Error parsing color variants:", error);
            }
        }
        // Handle size variants
        if (req.body.sizeVariants) {
            try {
                productData.sizeVariants = JSON.parse(req.body.sizeVariants);
            }
            catch (error) {
                console.error("Error parsing size variants:", error);
            }
        }
        // Generate slug if not present
        if (!productData.slug && productData.name) {
            productData.slug = productData.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "");
        }
        // Parse numeric/boolean fields
        if (productData.price)
            productData.price = Number(productData.price);
        if (productData.compareAtPrice)
            productData.compareAtPrice = Number(productData.compareAtPrice);
        if (productData.stock)
            productData.stock = Number(productData.stock);
        if (productData.featured)
            productData.featured =
                productData.featured === "true" || productData.featured === true;
        // Parse badges array
        if (productData.badges) {
            try {
                productData.badges = JSON.parse(productData.badges);
            }
            catch (error) {
                console.error("Error parsing badges:", error);
                productData.badges = [];
            }
        }
        console.log("Saving product data:", productData);
        const product = await product_1.default.create(productData);
        console.log("Product saved:", product._id);
        res.status(201).json({
            success: true,
            message: "Product created successfully",
            data: product,
        });
    }
    catch (error) {
        console.error("Error creating product:", error);
        // Cleanup files
        if (req.files) {
            const files = req.files;
            files.forEach((file) => {
                try {
                    if (fs_1.default.existsSync(file.path))
                        fs_1.default.unlinkSync(file.path);
                }
                catch (e) {
                    console.error("Error deleting file:", e);
                }
            });
        }
        // Handle duplicate SKU error
        if (error.code === 11000 && error.keyPattern?.sku) {
            return res.status(400).json({
                success: false,
                message: `Product with SKU "${error.keyValue.sku}" already exists. Please use a unique SKU.`,
                error: "Duplicate SKU",
            });
        }
        // Handle other duplicate key errors
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern || {})[0] || 'field';
            const value = error.keyValue?.[field] || 'value';
            return res.status(400).json({
                success: false,
                message: `A product with this ${field} "${value}" already exists.`,
                error: "Duplicate entry",
            });
        }
        // Generic error response
        res.status(500).json({
            success: false,
            message: "Error creating product",
            error: error.message,
        });
    }
};
exports.createProduct = createProduct;
// Update product
const updateProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const oldProduct = await product_1.default.findById(id);
        if (!oldProduct) {
            return res.status(404).json({
                success: false,
                message: "Product not found",
            });
        }
        const files = req.files;
        let newImages = [];
        // Separate main images from variant images
        const mainImages = files?.filter(file => file.fieldname === 'images') || [];
        // Upload new main images to ImgBB
        if (mainImages.length > 0) {
            for (const file of mainImages) {
                try {
                    const imageUrl = await (0, uploadToImgBB_1.uploadToImgBB)(file.path);
                    newImages.push({
                        url: imageUrl,
                        isPrimary: false,
                    });
                    fs_1.default.unlinkSync(file.path);
                }
                catch (uploadError) {
                    console.error("Image upload failed:", uploadError);
                    if (fs_1.default.existsSync(file.path))
                        fs_1.default.unlinkSync(file.path);
                }
            }
        }
        const updateData = { ...req.body };
        // Handle kept images from keptImages array
        let keptImages = [];
        if (req.body.keptImages) {
            const keptUrls = Array.isArray(req.body.keptImages)
                ? req.body.keptImages
                : [req.body.keptImages];
            keptImages = oldProduct.images
                .filter((img) => keptUrls.includes(img.url))
                .map((img) => ({
                url: img.url,
                alt: img.alt,
                isPrimary: img.isPrimary,
            }));
        }
        // Combine kept images with new images
        updateData.images = [...keptImages, ...newImages];
        // Ensure at least one image is primary
        if (updateData.images.length > 0 &&
            !updateData.images.some((img) => img.isPrimary)) {
            updateData.images[0].isPrimary = true;
        }
        // Handle color variants
        if (req.body.colorVariants) {
            try {
                const colorVariants = JSON.parse(req.body.colorVariants);
                const processedColorVariants = [];
                for (let i = 0; i < colorVariants.length; i++) {
                    const variant = colorVariants[i];
                    // Start with existing images
                    let variantImages = variant.images || [];
                    // Get new files for this color variant
                    const variantFiles = files?.filter(file => file.fieldname === `colorVariant_${i}_images`) || [];
                    // Upload new color variant images
                    for (const file of variantFiles) {
                        try {
                            const imageUrl = await (0, uploadToImgBB_1.uploadToImgBB)(file.path);
                            variantImages.push(imageUrl);
                            fs_1.default.unlinkSync(file.path);
                        }
                        catch (uploadError) {
                            console.error("Color variant image upload failed:", uploadError);
                            if (fs_1.default.existsSync(file.path))
                                fs_1.default.unlinkSync(file.path);
                        }
                    }
                    processedColorVariants.push({
                        color: variant.color,
                        colorCode: variant.colorCode,
                        images: variantImages,
                    });
                }
                updateData.colorVariants = processedColorVariants;
            }
            catch (error) {
                console.error("Error parsing color variants:", error);
            }
        }
        // Handle size variants
        if (req.body.sizeVariants) {
            try {
                updateData.sizeVariants = JSON.parse(req.body.sizeVariants);
            }
            catch (error) {
                console.error("Error parsing size variants:", error);
            }
        }
        // Parse numeric/boolean fields
        if (updateData.price)
            updateData.price = Number(updateData.price);
        if (updateData.compareAtPrice)
            updateData.compareAtPrice = Number(updateData.compareAtPrice);
        if (updateData.stock)
            updateData.stock = Number(updateData.stock);
        if (updateData.featured !== undefined)
            updateData.featured =
                updateData.featured === "true" || updateData.featured === true;
        // Parse badges array
        if (updateData.badges) {
            try {
                updateData.badges = JSON.parse(updateData.badges);
            }
            catch (error) {
                console.error("Error parsing badges:", error);
                updateData.badges = [];
            }
        }
        const updatedProduct = await product_1.default.findByIdAndUpdate(id, updateData, {
            new: true,
            runValidators: true,
        });
        res.status(200).json({
            success: true,
            message: "Product updated successfully",
            data: updatedProduct,
        });
    }
    catch (error) {
        console.error("Error updating product:", error);
        // Cleanup files
        if (req.files) {
            const files = req.files;
            files.forEach((file) => {
                try {
                    if (fs_1.default.existsSync(file.path))
                        fs_1.default.unlinkSync(file.path);
                }
                catch (e) {
                    console.error("Error deleting file:", e);
                }
            });
        }
        res.status(500).json({
            success: false,
            message: "Error updating product",
            error: error.message,
        });
    }
};
exports.updateProduct = updateProduct;
// Delete product
const deleteProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const product = await product_1.default.findByIdAndDelete(id);
        if (!product) {
            return res.status(404).json({
                success: false,
                message: "Product not found",
            });
        }
        res.status(200).json({
            success: true,
            message: "Product deleted successfully",
        });
    }
    catch (error) {
        console.error("Error deleting product:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting product",
            error: error.message,
        });
    }
};
exports.deleteProduct = deleteProduct;
// Get categories from Category model with product counts
const getCategories = async (req, res) => {
    try {
        // Fetch active categories from Category collection
        const categories = await category_1.default.find({ status: "active" })
            .select("title slug description image")
            .sort({ title: 1 });
        // Get product count for each category
        const categoriesWithCount = await Promise.all(categories.map(async (category) => {
            const productCount = await product_1.default.countDocuments({
                category: category.title,
                status: "active",
            });
            return {
                _id: category._id,
                title: category.title,
                slug: category.slug,
                description: category.description,
                image: category.image,
                productCount,
            };
        }));
        // Also include any categories from products that don't exist in Category collection
        const productCategories = await product_1.default.distinct("category");
        const existingCategoryTitles = categories.map(c => c.title);
        const orphanCategories = productCategories
            .filter((c) => c && c.trim() !== "" && !existingCategoryTitles.includes(c))
            .map((title) => ({
            title,
            slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
            productCount: 0, // Will be calculated below
            isOrphan: true, // Flag to indicate it's not in Category collection
        }));
        // Get product counts for orphan categories
        const orphanCategoriesWithCount = await Promise.all(orphanCategories.map(async (category) => {
            const productCount = await product_1.default.countDocuments({
                category: category.title,
                status: "active",
            });
            return {
                ...category,
                productCount,
            };
        }));
        // Combine and sort all categories
        const allCategories = [...categoriesWithCount, ...orphanCategoriesWithCount]
            .sort((a, b) => a.title.localeCompare(b.title));
        res.status(200).json({
            success: true,
            data: allCategories,
        });
    }
    catch (error) {
        console.error("Error fetching categories:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching categories",
            error: error.message,
        });
    }
};
exports.getCategories = getCategories;
//# sourceMappingURL=productController.js.map