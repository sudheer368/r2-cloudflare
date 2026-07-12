const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Validate environment variables
const requiredEnvVars = [
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID", 
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_ACCOUNT_ID"
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error("❌ Missing required environment variables:", missingVars.join(", "));
  throw new Error(`Missing environment variables: ${missingVars.join(", ")}`);
}

// Clean up endpoint URL
const endpoint = process.env.R2_ENDPOINT.replace(/\/$/, '');

console.log("🔧 Configuring R2 with:");
console.log(`  Endpoint: ${endpoint}`);
console.log(`  Bucket: ${process.env.R2_BUCKET_NAME}`);
console.log(`  Account ID: ${process.env.R2_ACCOUNT_ID}`);

// Configure Cloudflare R2
const s3 = new AWS.S3({
  endpoint: endpoint,
  accessKeyId: process.env.R2_ACCESS_KEY_ID.trim(),
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY.trim(),
  region: "auto",
  signatureVersion: "v4",
  s3ForcePathStyle: true,
  maxRetries: 3,
  retryDelayOptions: { base: 300 },
});

// MIME types mapping
const getContentType = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".json": "application/json",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".zip": "application/zip",
  };
  return mimeTypes[ext] || "application/octet-stream";
};

// Generate public URL for the file
// Change this function:
const getPublicUrl = (fileName) => {
  // ✅ Remove the bucket name from the path
  return `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev/${fileName}`;
};

async function uploadToR2(filePath, fileName) {
  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    console.log(`📤 Uploading ${fileName} to R2...`);
    
    const fileContent = fs.readFileSync(filePath);
    const contentType = getContentType(fileName);
    
    // Create upload parameters
    const params = {
      Bucket: process.env.R2_BUCKET_NAME.trim(),
      Key: fileName,
      Body: fileContent,
      ContentType: contentType,
      Metadata: {
        'uploaded-at': new Date().toISOString(),
        'original-name': fileName,
      }
    };

    console.log(`  Bucket: ${params.Bucket}`);
    console.log(`  Key: ${params.Key}`);
    console.log(`  Content-Type: ${contentType}`);
    console.log(`  File Size: ${(fileContent.length / 1024).toFixed(2)} KB`);

    // Upload to R2
    const upload = s3.upload(params);
    
    // Track upload progress
    upload.on('httpUploadProgress', (progress) => {
      if (progress.total > 0) {
        const percent = Math.round((progress.loaded / progress.total) * 100);
        if (percent % 10 === 0) {
          console.log(`  Upload progress: ${percent}%`);
        }
      }
    });

    const result = await upload.promise();
    
    // Generate public URL
    const publicUrl = getPublicUrl(fileName);
    
    console.log(`✅ File uploaded successfully`);
    console.log(`  Public URL: ${publicUrl}`);
    console.log(`  R2 URL: ${result.Location}`);
    
    // Clean up local file
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Local file deleted: ${filePath}`);
      }
    } catch (unlinkError) {
      console.warn(`⚠️ Could not delete local file: ${filePath}`, unlinkError.message);
    }
    
    // Return both the R2 URL and public URL
    return {
      ...result,
      publicUrl: publicUrl,
      fileName: fileName
    };
  } catch (error) {
    console.error("❌ Error uploading to R2:", error.message);
    
    // Clean up local file on error
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Cleaned up failed upload file: ${filePath}`);
      }
    } catch (unlinkError) {
      console.warn(`⚠️ Could not clean up file: ${filePath}`, unlinkError.message);
    }
    throw error;
  }
}

module.exports = uploadToR2;