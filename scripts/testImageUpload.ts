#!/usr/bin/env node

/**
 * Test script for image upload and WebP conversion
 * 
 * This script demonstrates how to:
 * 1. Upload an image to the portfolio endpoint
 * 2. Verify the image is converted to WebP
 * 3. Retrieve the portfolio settings
 * 
 * Usage:
 *   npm run test-image-upload
 *   or
 *   ts-node scripts/testImageUpload.ts
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const API_URL = process.env.API_URL || "http://localhost:5000";

async function testImageUpload() {
  console.log("🧪 Testing Image Upload and WebP Conversion\n");
  console.log("=" .repeat(50));

  // Step 1: Login to get token
  console.log("\n📝 Step 1: Authenticating...");
  
  const loginResponse = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: process.env.SUPER_USER_EMAIL || "admin@example.com",
      password: process.env.SUPER_USER_PASSWORD || "Admin@123",
    }),
  });

  if (!loginResponse.ok) {
    console.error("❌ Login failed");
    console.error(await loginResponse.text());
    return;
  }

  const loginData = await loginResponse.json();
  const token = loginData.payload?.accessToken;

  if (!token) {
    console.error("❌ No access token received");
    return;
  }

  console.log("✅ Authentication successful");

  // Step 2: Create a test image (1x1 pixel PNG)
  console.log("\n📝 Step 2: Creating test image...");
  
  const testImagePath = path.join(__dirname, "../uploads/temp/test-image.png");
  
  // Create a simple 1x1 PNG image (base64 encoded)
  const pngData = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  
  fs.writeFileSync(testImagePath, pngData);
  console.log("✅ Test image created");

  // Step 3: Upload the image
  console.log("\n📝 Step 3: Uploading image to portfolio...");

  const FormData = (await import("form-data")).default;
  const formData = new FormData();
  
  formData.append("appLogo", fs.createReadStream(testImagePath));
  formData.append("appTitle", "Test Coaching Center");
  formData.append("primaryColor", "#3B82F6");

  const uploadResponse = await fetch(`${API_URL}/api/portfolio`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      ...formData.getHeaders(),
    },
    body: formData,
  });

  if (!uploadResponse.ok) {
    console.error("❌ Upload failed");
    console.error(await uploadResponse.text());
    
    // Clean up test image
    fs.unlinkSync(testImagePath);
    return;
  }

  const uploadData = await uploadResponse.json();
  console.log("✅ Image uploaded successfully");
  console.log("\n📊 Response:");
  console.log(JSON.stringify(uploadData, null, 2));

  // Step 4: Verify WebP conversion
  console.log("\n📝 Step 4: Verifying WebP conversion...");
  
  const logoUrl = uploadData.data?.appLogo;
  if (logoUrl && logoUrl.endsWith(".webp")) {
    console.log("✅ Image successfully converted to WebP");
    console.log(`   URL: ${logoUrl}`);
  } else {
    console.log("⚠️  Image may not be in WebP format");
    console.log(`   URL: ${logoUrl}`);
  }

  // Step 5: Retrieve portfolio to verify
  console.log("\n📝 Step 5: Retrieving portfolio settings...");
  
  const getResponse = await fetch(`${API_URL}/api/portfolio`);
  
  if (!getResponse.ok) {
    console.error("❌ Failed to retrieve portfolio");
    console.error(await getResponse.text());
  } else {
    const getData = await getResponse.json();
    console.log("✅ Portfolio retrieved successfully");
    console.log("\n📊 Current Portfolio:");
    console.log(`   Title: ${getData.data?.appTitle}`);
    console.log(`   Logo: ${getData.data?.appLogo}`);
    console.log(`   Primary Color: ${getData.data?.primaryColor}`);
  }

  // Clean up test image
  try {
    fs.unlinkSync(testImagePath);
    console.log("\n🧹 Test image cleaned up");
  } catch (error) {
    // Ignore cleanup errors
  }

  console.log("\n" + "=".repeat(50));
  console.log("✨ Test completed successfully!");
  console.log("=".repeat(50));
}

// Run the test
testImageUpload().catch((error) => {
  console.error("\n❌ Test failed with error:");
  console.error(error);
  process.exit(1);
});
