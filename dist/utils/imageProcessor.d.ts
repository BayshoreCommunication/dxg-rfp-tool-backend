import sharp from "sharp";
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
export declare function convertToWebP(inputPath: string, outputDir: string, filename: string, options?: ImageProcessOptions): Promise<string>;
/**
 * Process multiple image sizes (thumbnail, medium, large)
 * @param inputPath - Path to the original image file
 * @param outputDir - Directory where the WebP images will be saved
 * @param baseFilename - Base name for the output files
 * @returns Object with paths to all generated sizes
 */
export declare function processMultipleSizes(inputPath: string, outputDir: string, baseFilename: string): Promise<{
    thumbnail: string;
    medium: string;
    large: string;
    original: string;
}>;
/**
 * Delete image file(s)
 * @param filePath - Path to the file or array of paths
 */
export declare function deleteImage(filePath: string | string[]): Promise<void>;
/**
 * Get image metadata
 * @param imagePath - Path to the image file
 */
export declare function getImageMetadata(imagePath: string): Promise<{
    format: keyof sharp.FormatEnum;
    width: number;
    height: number;
    size: number | undefined;
    hasAlpha: boolean;
}>;
//# sourceMappingURL=imageProcessor.d.ts.map