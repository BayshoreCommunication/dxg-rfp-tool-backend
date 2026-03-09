import fs from "fs";
import path from "path";
import sharp from "sharp";

interface ImgBBResponse {
  success: boolean;
  data: {
    id: string;
    url: string;
    // ... other fields
  };
  error?: {
    message: string;
  };
}

/**
 * Converts any image format to WebP using Sharp
 * @param inputPath Original image file path
 * @returns Path to the converted WebP file
 */
const convertToWebP = async (inputPath: string): Promise<string> => {
  try {
    const parsedPath = path.parse(inputPath);
    const outputPath = path.join(parsedPath.dir, `${parsedPath.name}.webp`);

    // Convert image to WebP with optimized settings
    await sharp(inputPath)
      .webp({
        quality: 85, // Good balance between quality and file size
        effort: 6,   // Compression effort (0-6, higher = better compression but slower)
      })
      .toFile(outputPath);

    // Delete original file after conversion
    if (fs.existsSync(inputPath)) {
      fs.unlinkSync(inputPath);
    }

    return outputPath;
  } catch (error: any) {
    console.error("WebP conversion error:", error);
    throw new Error(`Failed to convert image to WebP: ${error.message}`);
  }
};

/**
 * Uploads an image to ImgBB after converting it to WebP format
 * @param filePath Path to the image file (any format)
 * @returns The URL of the uploaded WebP image
 */
export const uploadToImgBB = async (filePath: string): Promise<string> => {
  const apiKey = process.env.IMAGEBB_API_KEY;

  if (!apiKey) {
    throw new Error("IMAGEBB_API_KEY is not defined in environment variables");
  }

  let webpPath = filePath;

  try {
    // Convert to WebP if not already in WebP format
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".webp") {
      console.log(`Converting ${ext} to WebP...`);
      webpPath = await convertToWebP(filePath);
      console.log(`Converted to WebP: ${webpPath}`);
    }

    // Read the WebP file
    const fileStream = fs.readFileSync(webpPath);
    const base64Image = fileStream.toString("base64");

    const formData = new URLSearchParams();
    formData.append("key", apiKey);
    formData.append("image", base64Image);

    const response = await fetch("https://api.imgbb.com/1/upload", {
      method: "POST",
      body: formData,
    });

    const data = (await response.json()) as ImgBBResponse;

    if (data.success) {
      // Clean up the local WebP file after successful upload
      if (fs.existsSync(webpPath)) {
        fs.unlinkSync(webpPath);
      }
      return data.data.url;
    } else {
      throw new Error(data.error?.message || "Failed to upload to ImgBB");
    }
  } catch (error: any) {
    // Clean up files in case of error
    if (webpPath !== filePath && fs.existsSync(webpPath)) {
      fs.unlinkSync(webpPath);
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    throw new Error(`ImgBB Upload Error: ${error.message}`);
  }
};

/**
 * Converts an image to WebP and saves it to the specified output path
 * Useful for direct file conversions without uploading
 * @param inputPath Original image file path
 * @param outputPath Desired output path for WebP file
 * @param options Sharp WebP options
 */
export const convertImageToWebP = async (
  inputPath: string,
  outputPath?: string,
  options?: { quality?: number; effort?: number }
): Promise<string> => {
  try {
    const finalOutputPath = outputPath || inputPath.replace(path.extname(inputPath), ".webp");
    
    await sharp(inputPath)
      .webp({
        quality: options?.quality || 85,
        effort: options?.effort || 6,
      })
      .toFile(finalOutputPath);

    return finalOutputPath;
  } catch (error: any) {
    throw new Error(`WebP conversion failed: ${error.message}`);
  }
};