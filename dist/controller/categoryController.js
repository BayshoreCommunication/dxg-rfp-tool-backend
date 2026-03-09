"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteCategory = exports.updateCategory = exports.createCategory = exports.getCategory = exports.getCategories = void 0;
const fs_1 = __importDefault(require("fs"));
const category_1 = __importDefault(require("../modal/category"));
const product_1 = __importDefault(require("../modal/product"));
const uploadToImgBB_1 = require("../utils/uploadToImgBB");
// Get all categories with pagination and filters
const getCategories = async (req, res) => {
    try {
        const { page = 1, limit = 20, status, search, sortBy = "createdAt", sortOrder = "desc", } = req.query;
        const query = {};
        // Filter by status
        if (status) {
            query.status = status;
        }
        // Search by title or description
        if (search) {
            query.$or = [
                { title: { $regex: search, $options: "i" } },
                { description: { $regex: search, $options: "i" } },
            ];
        }
        const skip = (Number(page) - 1) * Number(limit);
        const sort = {};
        sort[sortBy] = sortOrder === "asc" ? 1 : -1;
        const categories = await category_1.default.find(query)
            .populate("createdBy", "name email")
            .sort(sort)
            .limit(Number(limit))
            .skip(skip);
        // Get product count for each category
        const categoriesWithCount = await Promise.all(categories.map(async (category) => {
            const productCount = await product_1.default.countDocuments({
                category: category.title,
                status: "active",
            });
            return {
                ...category.toObject(),
                productCount,
            };
        }));
        const total = await category_1.default.countDocuments(query);
        res.status(200).json({
            success: true,
            data: categoriesWithCount,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit)),
            },
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
// Get single category by ID or slug
const getCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { slug: id };
        const category = await category_1.default.findOne(query).populate("createdBy", "name email");
        if (!category) {
            return res.status(404).json({
                success: false,
                message: "Category not found",
            });
        }
        // Get product count
        const productCount = await product_1.default.countDocuments({
            category: category.title,
            status: "active",
        });
        return res.status(200).json({
            success: true,
            data: {
                ...category.toObject(),
                productCount,
            },
        });
    }
    catch (error) {
        console.error("Error fetching category:", error);
        return res.status(500).json({
            success: false,
            message: "Error fetching category",
            error: error.message,
        });
    }
};
exports.getCategory = getCategory;
// Create new category
const createCategory = async (req, res) => {
    try {
        console.log("Create Category Request Body:", req.body);
        console.log("Create Category Request File:", req.file);
        let imageUrl = "";
        // Upload category image if provided
        if (req.file) {
            try {
                console.log(`Uploading category image: ${req.file.path}`);
                imageUrl = await (0, uploadToImgBB_1.uploadToImgBB)(req.file.path);
                console.log(`Uploaded successfully: ${imageUrl}`);
                fs_1.default.unlinkSync(req.file.path);
            }
            catch (uploadError) {
                console.error("Image upload failed:", uploadError);
                if (fs_1.default.existsSync(req.file.path))
                    fs_1.default.unlinkSync(req.file.path);
                throw new Error(`Failed to upload image: ${uploadError.message}`);
            }
        }
        const categoryData = {
            ...req.body,
            image: imageUrl,
            createdBy: req.user?.userId,
        };
        // Generate slug if not present
        if (!categoryData.slug && categoryData.title) {
            categoryData.slug = categoryData.title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "");
        }
        console.log("Saving category data:", categoryData);
        const category = await category_1.default.create(categoryData);
        console.log("Category saved:", category._id);
        res.status(201).json({
            success: true,
            message: "Category created successfully",
            data: category,
        });
    }
    catch (error) {
        console.error("Error creating category:", error);
        // Cleanup file
        if (req.file && fs_1.default.existsSync(req.file.path)) {
            fs_1.default.unlinkSync(req.file.path);
        }
        res.status(500).json({
            success: false,
            message: "Error creating category",
            error: error.message,
        });
    }
};
exports.createCategory = createCategory;
// Update category
const updateCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const oldCategory = await category_1.default.findById(id);
        if (!oldCategory) {
            return res.status(404).json({
                success: false,
                message: "Category not found",
            });
        }
        let imageUrl = oldCategory.image;
        // Upload new image if provided
        if (req.file) {
            try {
                imageUrl = await (0, uploadToImgBB_1.uploadToImgBB)(req.file.path);
                fs_1.default.unlinkSync(req.file.path);
            }
            catch (uploadError) {
                console.error("Image upload failed:", uploadError);
                if (fs_1.default.existsSync(req.file.path))
                    fs_1.default.unlinkSync(req.file.path);
            }
        }
        const updateData = { ...req.body, image: imageUrl };
        // Update slug if title changed
        if (updateData.title && updateData.title !== oldCategory.title) {
            updateData.slug = updateData.title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "");
        }
        const updatedCategory = await category_1.default.findByIdAndUpdate(id, updateData, {
            new: true,
            runValidators: true,
        });
        res.status(200).json({
            success: true,
            message: "Category updated successfully",
            data: updatedCategory,
        });
    }
    catch (error) {
        console.error("Error updating category:", error);
        // Cleanup file
        if (req.file && fs_1.default.existsSync(req.file.path)) {
            fs_1.default.unlinkSync(req.file.path);
        }
        res.status(500).json({
            success: false,
            message: "Error updating category",
            error: error.message,
        });
    }
};
exports.updateCategory = updateCategory;
// Delete category
const deleteCategory = async (req, res) => {
    try {
        const { id } = req.params;
        // Check if any products use this category
        const categoryToDelete = await category_1.default.findById(id);
        if (!categoryToDelete) {
            return res.status(404).json({
                success: false,
                message: "Category not found",
            });
        }
        const productsUsingCategory = await product_1.default.countDocuments({
            category: categoryToDelete.title,
        });
        if (productsUsingCategory > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete category. ${productsUsingCategory} product(s) are using this category.`,
            });
        }
        await category_1.default.findByIdAndDelete(id);
        res.status(200).json({
            success: true,
            message: "Category deleted successfully",
        });
    }
    catch (error) {
        console.error("Error deleting category:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting category",
            error: error.message,
        });
    }
};
exports.deleteCategory = deleteCategory;
//# sourceMappingURL=categoryController.js.map