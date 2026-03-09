# Image Processing Utilities

This directory contains utilities for handling image uploads and processing in the Coaching Center backend.

## Features

### 1. Automatic WebP Conversion

All uploaded images are automatically converted to WebP format using Sharp, which provides:

- **Smaller file sizes** (typically 25-35% smaller than JPEG/PNG)
- **Better quality** at lower file sizes
- **Faster loading times** for web applications
- **Modern browser support**

### 2. Image Processing (`imageProcessor.ts`)

#### Main Functions:

##### `convertToWebP(inputPath, outputDir, filename, options)`

Converts any image format to WebP.

**Parameters:**

- `inputPath`: Path to the original uploaded image
- `outputDir`: Directory where the WebP image will be saved
- `filename`: Name for the output file (without extension)
- `options`: Object with optional properties:
  - `width`: Target width (optional)
  - `height`: Target height (optional)
  - `quality`: WebP quality 1-100 (default: 80)
  - `fit`: Resize fit mode (default: 'cover')

**Returns:** Path to the converted WebP image

**Example:**

```typescript
const webpPath = await convertToWebP(
  "/tmp/upload-123.jpg",
  "/uploads/portfolio",
  "logo-1234567890",
  { width: 800, height: 800, quality: 85 }
);
// Returns: '/uploads/portfolio/logo-1234567890.webp'
```

##### `processMultipleSizes(inputPath, outputDir, baseFilename)`

Creates multiple sizes of an image (thumbnail, medium, large, original).

**Returns:**

```typescript
{
  thumbnail: string; // 150x150
  medium: string; // 500x500
  large: string; // 1200x1200
  original: string; // Original size
}
```

##### `deleteImage(filePath)`

Safely deletes image file(s).

**Parameters:**

- `filePath`: String path or array of paths

##### `getImageMetadata(imagePath)`

Gets image metadata (format, dimensions, size, etc.)

### 3. Upload Middleware (`middleware/upload.ts`)

#### Configuration:

- **Max file size:** 10MB
- **Allowed formats:** JPEG, PNG, GIF, WebP, SVG, BMP
- **Temporary storage:** `/uploads/temp`

#### Middleware Functions:

##### `uploadSingle(fieldName)`

Handles single file upload.

**Example:**

```typescript
router.post("/profile", uploadSingle("avatar"), controller);
```

##### `uploadMultiple(fieldName, maxCount)`

Handles multiple files for a single field.

**Example:**

```typescript
router.post("/gallery", uploadMultiple("photos", 10), controller);
```

##### `uploadFields(fields)`

Handles multiple fields with different names.

**Example:**

```typescript
const fields = [
  { name: "appLogo", maxCount: 1 },
  { name: "favicon", maxCount: 1 },
];
router.post("/settings", uploadFields(fields), controller);
```

## Usage in Controllers

### Portfolio Controller Example

```typescript
import { convertToWebP, deleteImage } from "../utils/imageProcessor";

// Process uploaded image
async function processUploadedImage(file: Express.Multer.File) {
  const uploadsDir = path.join(__dirname, "../../uploads/portfolio");
  const filename = `logo-${Date.now()}`;

  // Convert to WebP
  const webpPath = await convertToWebP(file.path, uploadsDir, filename, {
    width: 800,
    height: 800,
    quality: 85,
  });

  // Return URL path
  return `/uploads/portfolio/${path.basename(webpPath)}`;
}

// In your route handler
export const updatePortfolio = async (req: AuthRequest, res: Response) => {
  const files = req.files as { [fieldname: string]: Express.Multer.File[] };

  if (files?.appLogo?.[0]) {
    const logoUrl = await processUploadedImage(files.appLogo[0]);
    // Save logoUrl to database
  }

  // Delete old image if needed
  if (oldLogoPath) {
    await deleteImage(oldLogoPath);
  }
};
```

## API Endpoints

### Upload Portfolio Images

**POST/PUT/PATCH** `/api/portfolio`

**Headers:**

```
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Form Data:**

```
appLogo: [File] (optional)
favicon: [File] (optional)
appTitle: string
primaryColor: string
... other fields
```

**Response:**

```json
{
  "success": true,
  "message": "Portfolio settings updated successfully",
  "data": {
    "appTitle": "Coaching Center",
    "appLogo": "/uploads/portfolio/logos/logo-1234567890.webp",
    "favicon": "/uploads/portfolio/favicons/favicon-1234567890.webp",
    ...
  }
}
```

## Directory Structure

```
backend/
├── uploads/
│   ├── temp/                 # Temporary upload storage
│   └── portfolio/
│       ├── logos/           # Converted logo images
│       └── favicons/        # Converted favicon images
├── utils/
│   └── imageProcessor.ts    # Image processing utilities
└── middleware/
    └── upload.ts            # Multer upload configuration
```

## Testing with cURL

### Upload Logo

```bash
curl -X PUT http://localhost:5000/api/portfolio \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "appLogo=@/path/to/image.jpg" \
  -F "appTitle=My Coaching Center"
```

### Upload Multiple Files

```bash
curl -X PUT http://localhost:5000/api/portfolio \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "appLogo=@/path/to/logo.jpg" \
  -F "favicon=@/path/to/favicon.png" \
  -F "appTitle=My Coaching Center"
```

## Frontend Integration (Next.js)

```typescript
// Upload with FormData
const formData = new FormData();
formData.append("appLogo", logoFile);
formData.append("appTitle", "Coaching Center");

const response = await fetch(`${API_URL}/api/portfolio`, {
  method: "PUT",
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
  body: formData,
});

const result = await response.json();
console.log("Logo URL:", result.data.appLogo);
```

## Error Handling

The image processor includes comprehensive error handling:

1. **Invalid file types** → Rejected by multer fileFilter
2. **File too large** → 413 error with descriptive message
3. **Conversion fails** → Original file is deleted, error thrown
4. **Disk space issues** → Error logged and returned to client

## Performance Considerations

- Images are processed asynchronously
- Original files are deleted after successful conversion
- Old images are deleted when new ones are uploaded
- WebP format provides 25-35% size reduction
- Automatic cleanup of temporary files

## Dependencies

- **multer**: ^1.4.x - File upload handling
- **sharp**: ^0.33.x - Image processing and conversion
- **@types/multer**: Development dependency for TypeScript

## Notes

- All uploaded images are automatically converted to WebP
- Original files are not kept after conversion
- The `/uploads` directory is served statically
- Images are accessible at `http://localhost:5000/uploads/...`
- Old images are automatically deleted when updated
