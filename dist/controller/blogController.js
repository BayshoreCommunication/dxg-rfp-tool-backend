"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCategories = exports.deleteBlog = exports.updateBlog = exports.createBlog = exports.getBlog = exports.getBlogs = void 0;
const fs_1 = __importDefault(require("fs"));
const blog_1 = __importDefault(require("../modal/blog"));
const uploadToImgBB_1 = require("../utils/uploadToImgBB");
// Get all blogs with pagination and filters
const getBlogs = async (req, res) => {
    try {
        const { page = 1, limit = 20, status, search, sortBy = "createdAt", sortOrder = "desc", featured, category, } = req.query;
        const query = {};
        // Filter by status
        if (status) {
            query.status = status;
        }
        // Filter by category
        if (category) {
            query.category = { $regex: category, $options: "i" };
        }
        // Filter by featured
        if (featured !== undefined) {
            query.featured = featured === "true";
        }
        // Search
        if (search) {
            query.$or = [
                { title: { $regex: search, $options: "i" } },
                { body: { $regex: search, $options: "i" } },
                { author: { $regex: search, $options: "i" } },
                { tags: { $in: [new RegExp(search, "i")] } },
            ];
        }
        const skip = (Number(page) - 1) * Number(limit);
        const sort = {};
        sort[sortBy] = sortOrder === "asc" ? 1 : -1;
        const blogs = await blog_1.default.find(query)
            .populate("createdBy", "name email")
            .sort(sort)
            .limit(Number(limit))
            .skip(skip);
        const total = await blog_1.default.countDocuments(query);
        res.status(200).json({
            success: true,
            data: blogs,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit)),
            },
        });
    }
    catch (error) {
        console.error("Error fetching blogs:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching blogs",
            error: error.message,
        });
    }
};
exports.getBlogs = getBlogs;
// Get single blog by ID or slug
const getBlog = async (req, res) => {
    try {
        const { id } = req.params;
        const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { slug: id };
        const blog = await blog_1.default.findOne(query).populate("createdBy", "name email");
        if (!blog) {
            return res.status(404).json({
                success: false,
                message: "Blog not found",
            });
        }
        return res.status(200).json({
            success: true,
            data: blog,
        });
    }
    catch (error) {
        console.error("Error fetching blog:", error);
        return res.status(500).json({
            success: false,
            message: "Error fetching blog",
            error: error.message,
        });
    }
};
exports.getBlog = getBlog;
// Create new blog
const createBlog = async (req, res) => {
    try {
        console.log("Create Blog Request Body:", req.body);
        console.log("Create Blog Request File:", req.file);
        let featuredImage = "";
        // Upload featured image if provided
        if (req.file) {
            try {
                console.log(`Uploading featured image: ${req.file.path}`);
                featuredImage = await (0, uploadToImgBB_1.uploadToImgBB)(req.file.path);
                console.log(`Uploaded successfully: ${featuredImage}`);
                fs_1.default.unlinkSync(req.file.path);
            }
            catch (uploadError) {
                console.error("Image upload failed:", uploadError);
                if (fs_1.default.existsSync(req.file.path))
                    fs_1.default.unlinkSync(req.file.path);
                throw new Error(`Failed to upload image: ${uploadError.message}`);
            }
        }
        const blogData = {
            ...req.body,
            featuredImage,
            createdBy: req.user?.userId,
        };
        // Generate slug if not present
        if (!blogData.slug && blogData.title) {
            blogData.slug = blogData.title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "");
        }
        // Parse tags if it's a string
        if (typeof blogData.tags === "string") {
            blogData.tags = blogData.tags.split(",").map((tag) => tag.trim());
        }
        // Parse boolean fields
        if (blogData.featured !== undefined) {
            blogData.featured =
                blogData.featured === "true" || blogData.featured === true;
        }
        // Set publishedAt if status is published
        if (blogData.status === "published" && !blogData.publishedAt) {
            blogData.publishedAt = new Date();
        }
        console.log("Saving blog data:", blogData);
        const blog = await blog_1.default.create(blogData);
        console.log("Blog saved:", blog._id);
        res.status(201).json({
            success: true,
            message: "Blog created successfully",
            data: blog,
        });
    }
    catch (error) {
        console.error("Error creating blog:", error);
        // Cleanup file
        if (req.file && fs_1.default.existsSync(req.file.path)) {
            fs_1.default.unlinkSync(req.file.path);
        }
        res.status(500).json({
            success: false,
            message: "Error creating blog",
            error: error.message,
        });
    }
};
exports.createBlog = createBlog;
// Update blog
const updateBlog = async (req, res) => {
    try {
        const { id } = req.params;
        const oldBlog = await blog_1.default.findById(id);
        if (!oldBlog) {
            return res.status(404).json({
                success: false,
                message: "Blog not found",
            });
        }
        let featuredImage = oldBlog.featuredImage;
        // Upload new featured image if provided
        if (req.file) {
            try {
                featuredImage = await (0, uploadToImgBB_1.uploadToImgBB)(req.file.path);
                fs_1.default.unlinkSync(req.file.path);
            }
            catch (uploadError) {
                console.error("Image upload failed:", uploadError);
                if (fs_1.default.existsSync(req.file.path))
                    fs_1.default.unlinkSync(req.file.path);
            }
        }
        const updateData = { ...req.body, featuredImage };
        // Parse tags if it's a string
        if (typeof updateData.tags === "string") {
            updateData.tags = updateData.tags.split(",").map((tag) => tag.trim());
        }
        // Parse boolean fields
        if (updateData.featured !== undefined) {
            updateData.featured =
                updateData.featured === "true" || updateData.featured === true;
        }
        // Update publishedAt if status changed to published
        if (updateData.status === "published" &&
            oldBlog.status !== "published" &&
            !updateData.publishedAt) {
            updateData.publishedAt = new Date();
        }
        const updatedBlog = await blog_1.default.findByIdAndUpdate(id, updateData, {
            new: true,
            runValidators: true,
        });
        res.status(200).json({
            success: true,
            message: "Blog updated successfully",
            data: updatedBlog,
        });
    }
    catch (error) {
        console.error("Error updating blog:", error);
        // Cleanup file
        if (req.file && fs_1.default.existsSync(req.file.path)) {
            fs_1.default.unlinkSync(req.file.path);
        }
        res.status(500).json({
            success: false,
            message: "Error updating blog",
            error: error.message,
        });
    }
};
exports.updateBlog = updateBlog;
// Delete blog
const deleteBlog = async (req, res) => {
    try {
        const { id } = req.params;
        const blog = await blog_1.default.findByIdAndDelete(id);
        if (!blog) {
            return res.status(404).json({
                success: false,
                message: "Blog not found",
            });
        }
        res.status(200).json({
            success: true,
            message: "Blog deleted successfully",
        });
    }
    catch (error) {
        console.error("Error deleting blog:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting blog",
            error: error.message,
        });
    }
};
exports.deleteBlog = deleteBlog;
// Get unique categories
const getCategories = async (req, res) => {
    try {
        const categories = await blog_1.default.distinct("category");
        // Filter out empty or null categories and sort alphabetically
        const cleanCategories = categories
            .filter((c) => c && c.trim() !== "")
            .sort((a, b) => a.localeCompare(b));
        res.status(200).json({
            success: true,
            data: cleanCategories,
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
//# sourceMappingURL=blogController.js.map