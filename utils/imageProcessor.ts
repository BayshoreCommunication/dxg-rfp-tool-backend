import fs from "fs";
import path from "path";
import sharp from "sharp";
import { promisify } from "util";

const unlinkAsync = promisify(fs.unlink);
const mkdirAsync = promisify(fs.mkdir);

export interface ImageProcessOptions {
  width?: number;
  height?: number;
  quality?: number;
  fit?: keyof sharp.FitEnum;
}

/**
 * Convert image to WebP format using Sharp
 * @param inputPath - Path to the original image file
 * @param outputDir - Directory where the WebP image will be saved
 * @param filename - Name for the output file (without extension)
 * @param options - Image processing options
 * @returns Path to the converted WebP image
 */
export async function convertToWebP(
  inputPath: string,
  outputDir: string,
  filename: string,
  options: ImageProcessOptions = {}
): Promise<string> {
  try {
    // Ensure output directory exists
    await mkdirAsync(outputDir, { recursive: true });

    // Generate output filename with .webp extension
    const outputFilename = `${filename}.webp`;
    const outputPath = path.join(outputDir, outputFilename);

    // Default options
    const { width, height, quality = 80, fit = "cover" } = options;

    // Process image with Sharp
    let sharpInstance = sharp(inputPath);

    // Resize if dimensions are provided
    if (width || height) {
      sharpInstance = sharpInstance.resize(width, height, {
        fit,
        withoutEnlargement: true,
      });
    }

    // Convert to WebP
    await sharpInstance.webp({ quality }).toFile(outputPath);

    // Delete original file after successful conversion
    try {
      await unlinkAsync(inputPath);
    } catch (error) {
      console.error("Error deleting original file:", error);
    }

    return outputPath;
  } catch (error) {
    console.error("Error converting image to WebP:", error);
    // Delete the original file even if conversion fails
    try {
      await unlinkAsync(inputPath);
    } catch (unlinkError) {
      console.error(
        "Error deleting original file after failed conversion:",
        unlinkError
      );
    }
    throw new Error(
      `Failed to convert image to WebP: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

/**
 * Process multiple image sizes (thumbnail, medium, large)
 * @param inputPath - Path to the original image file
 * @param outputDir - Directory where the WebP images will be saved
 * @param baseFilename - Base name for the output files
 * @returns Object with paths to all generated sizes
 */
export async function processMultipleSizes(
  inputPath: string,
  outputDir: string,
  baseFilename: string
): Promise<{
  thumbnail: string;
  medium: string;
  large: string;
  original: string;
}> {
  try {
    await mkdirAsync(outputDir, { recursive: true });

    const sizes: Array<{
      name: string;
      width?: number;
      height?: number;
      quality: number;
    }> = [
      { name: "thumbnail", width: 150, height: 150, quality: 80 },
      { name: "medium", width: 500, height: 500, quality: 85 },
      { name: "large", width: 1200, height: 1200, quality: 90 },
      { name: "original", quality: 90 },
    ];

    const results: any = {};

    for (const sizeConfig of sizes) {
      const filename =
        sizeConfig.name === "original"
          ? baseFilename
          : `${baseFilename}-${sizeConfig.name}`;

      const outputFilename = `${filename}.webp`;
      const outputPath = path.join(outputDir, outputFilename);

      let sharpInstance = sharp(inputPath);

      if (sizeConfig.width && sizeConfig.height) {
        sharpInstance = sharpInstance.resize(
          sizeConfig.width,
          sizeConfig.height,
          {
            fit: "cover",
            withoutEnlargement: true,
          }
        );
      }

      await sharpInstance
        .webp({ quality: sizeConfig.quality })
        .toFile(outputPath);

      results[sizeConfig.name] = outputPath;
    }

    // Delete original file after all conversions
    try {
      await unlinkAsync(inputPath);
    } catch (error) {
      console.error("Error deleting original file:", error);
    }

    return results;
  } catch (error) {
    console.error("Error processing multiple sizes:", error);
    // Clean up original file
    try {
      await unlinkAsync(inputPath);
    } catch (unlinkError) {
      console.error(
        "Error deleting original file after failed processing:",
        unlinkError
      );
    }
    throw new Error(
      `Failed to process multiple sizes: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

/**
 * Delete image file(s)
 * @param filePath - Path to the file or array of paths
 */
export async function deleteImage(filePath: string | string[]): Promise<void> {
  try {
    const paths = Array.isArray(filePath) ? filePath : [filePath];

    for (const path of paths) {
      if (fs.existsSync(path)) {
        await unlinkAsync(path);
      }
    }
  } catch (error) {
    console.error("Error deleting image:", error);
    throw error;
  }
}

/**
 * Get image metadata
 * @param imagePath - Path to the image file
 */
export async function getImageMetadata(imagePath: string) {
  try {
    const metadata = await sharp(imagePath).metadata();
    return {
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      size: metadata.size,
      hasAlpha: metadata.hasAlpha,
    };
  } catch (error) {
    console.error("Error getting image metadata:", error);
    throw error;
  }
}

/**
 * Convert image URL to WebP format (downloads, converts, returns buffer)
 * @param imageUrl - URL of the image to convert
 * @param quality - WebP quality (1-100, default: 85)
 * @param timeout - Request timeout in milliseconds (default: 30000)
 * @returns Buffer containing WebP image data
 */
export async function convertImageUrlToWebP(
  imageUrl: string,
  quality: number = 85,
  timeout: number = 30000
): Promise<Buffer | null> {
  try {
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Download the image with timeout
      const response = await fetch(imageUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ImageConverter/1.0)',
        },
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
      }

      const imageBuffer = Buffer.from(await response.arrayBuffer());

      // Check if image is already WebP
      try {
        const metadata = await sharp(imageBuffer).metadata();
        if (metadata.format === "webp") {
          return imageBuffer; // Already WebP, return as-is
        }
      } catch (metadataError) {
        // Continue with conversion if metadata check fails
      }

      // Handle SVG - Sharp needs to rasterize SVG first
      // For SVG, we'll convert to PNG first, then to WebP
      let sharpInstance = sharp(imageBuffer);

      // Check if it's SVG by file extension or content type
      const isSvg =
        imageUrl.toLowerCase().endsWith(".svg") ||
        imageBuffer.toString().includes("<svg");

      if (isSvg) {
        // Rasterize SVG to PNG first, then convert to WebP
        sharpInstance = sharpInstance.png();
      }

      // Convert to WebP using Sharp
      const webpBuffer = await sharpInstance.webp({ quality }).toBuffer();

      return webpBuffer;
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      throw fetchError;
    }
  } catch (error) {
    console.error(`Error converting image URL to WebP (${imageUrl}):`, error instanceof Error ? error.message : error);
    // Return null to indicate failure - caller should handle gracefully
    return null;
  }
}

/**
 * Convert image URL to WebP data URL (base64)
 * @param imageUrl - URL of the image to convert
 * @param quality - WebP quality (1-100, default: 85)
 * @param timeout - Request timeout in milliseconds (default: 30000)
 * @returns Data URL string (data:image/webp;base64,...) or null if conversion fails
 */
export async function convertImageUrlToWebPDataUrl(
  imageUrl: string,
  quality: number = 85,
  timeout: number = 30000
): Promise<string | null> {
  try {
    const webpBuffer = await convertImageUrlToWebP(imageUrl, quality, timeout);
    if (!webpBuffer) {
      return null; // Conversion failed
    }
    const base64 = webpBuffer.toString("base64");
    return `data:image/webp;base64,${base64}`;
  } catch (error) {
    console.error("Error converting image URL to WebP data URL:", error);
    return null; // Return null instead of throwing
  }
}

/**
 * Process product images and convert URLs to WebP format
 * This function handles both single images and arrays of images
 * @param images - Product images array or single image object
 * @param quality - WebP quality (1-100, default: 85)
 * @param timeout - Request timeout in milliseconds (default: 15000)
 * @returns Processed images with WebP data URLs (falls back to original URLs on failure)
 */
export async function processProductImagesToWebP(
  images: Array<{ url: string; alt?: string; isPrimary?: boolean }> | undefined,
  quality: number = 85,
  timeout: number = 15000
): Promise<Array<{ url: string; alt?: string; isPrimary?: boolean }>> {
  if (!images || images.length === 0) {
    return [];
  }

  try {
    // Process images with timeout and error handling
    const processedImages = await Promise.allSettled(
      images.map(async (image) => {
        try {
          // Skip if already WebP or data URL
          if (
            image.url.startsWith("data:") ||
            image.url.toLowerCase().endsWith(".webp")
          ) {
            return image;
          }

          // Convert to WebP data URL with timeout
          const webpDataUrl = await convertImageUrlToWebPDataUrl(
            image.url,
            quality,
            timeout
          );

          // If conversion failed, return original image
          if (!webpDataUrl) {
            return image;
          }

          return {
            ...image,
            url: webpDataUrl,
          };
        } catch (error) {
          console.error(
            `Error processing image ${image.url}:`,
            error instanceof Error ? error.message : error
          );
          // Return original image if conversion fails
          return image;
        }
      })
    );

    // Extract results, using original image if promise was rejected
    return processedImages.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      } else {
        // If promise was rejected, return original image
        console.error(
          `Failed to process image at index ${index}:`,
          result.reason
        );
        return images[index];
      }
    });
  } catch (error) {
    console.error("Error processing product images:", error);
    // Return original images if processing fails
    return images;
  }
}