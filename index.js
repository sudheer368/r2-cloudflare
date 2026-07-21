const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const AWS = require("aws-sdk");
const crypto = require("crypto");

const app = express();

// Environment variables
const ENV = {
  R2_ENDPOINT: "https://8d6d71696c62d814030a8b94486298a6.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "a708c3b8ea970da1adb0cc4cb3822a74",
  R2_SECRET_ACCESS_KEY: "b9e9376fc15ffb2c6a16c1fee5e61a6b100abee555b79c18bde0a2d8db1cace0",
  R2_BUCKET_NAME: "timeline",
  R2_ACCOUNT_ID: "9074667375914ae7aa1345f9e0d9a0a5",
  PORT: 3000,
  MAX_FILE_SIZE: 100 * 1024 * 1024 // 100MB for videos
};

// Clean up endpoint URL
const endpoint = ENV.R2_ENDPOINT.replace(/\/$/, '');

// Configure Cloudflare R2
const s3 = new AWS.S3({
  endpoint: endpoint,
  accessKeyId: ENV.R2_ACCESS_KEY_ID.trim(),
  secretAccessKey: ENV.R2_SECRET_ACCESS_KEY.trim(),
  region: "auto",
  signatureVersion: "v4",
  s3ForcePathStyle: true,
  maxRetries: 3,
  retryDelayOptions: { base: 300 },
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// MIME types mapping
const getContentType = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    // Images
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
    
    // Videos
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".flv": "video/x-flv",
    ".wmv": "video/x-ms-wmv",
    ".m4v": "video/x-m4v",
    ".3gp": "video/3gpp",
    ".ogv": "video/ogg",
    ".mpeg": "video/mpeg",
    
    // Audio
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    
    // Documents
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".json": "application/json",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".zip": "application/zip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return mimeTypes[ext] || "application/octet-stream";
};

// Get media type for categorization
const getMediaType = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.ico', '.avif'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.ogv', '.mpeg'];
  const audioExts = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
  
  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  return 'other';
};

// Generate public URL for the file
const getPublicUrl = (fileName) => {
  return `https://pub-${ENV.R2_ACCOUNT_ID}.r2.dev/${fileName}`;
};

// Upload function with user metadata
async function uploadToR2(filePath, fileName, metadata = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }
    
    const fileContent = fs.readFileSync(filePath);
    const contentType = getContentType(fileName);
    const mediaType = getMediaType(fileName);
    
    // Generate a unique hash for the file
    const fileHash = crypto.createHash('md5').update(fileContent).digest('hex');
    
    // Sanitize filename to ensure uniqueness
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.]/g, "_");
    const uniqueKey = `${Date.now()}-${sanitizedFileName}`;
    
    // Extract user metadata
    const userUid = metadata.userUid || 'anonymous';
    const followersDocId = metadata.followersDocId || 'unknown';
    
    const params = {
      Bucket: ENV.R2_BUCKET_NAME.trim(),
      Key: uniqueKey,
      Body: fileContent,
      ContentType: contentType,
      Metadata: {
        'uploaded-at': new Date().toISOString(),
        'original-name': fileName,
        'file-hash': fileHash,
        'media-type': mediaType,
        'file-size': fileContent.length.toString(),
        'user-uid': userUid,
        'followers-doc-id': followersDocId,
        // Include all other metadata
        ...Object.keys(metadata).reduce((acc, key) => {
          if (!['userUid', 'followersDocId'].includes(key)) {
            acc[key] = String(metadata[key]);
          }
          return acc;
        }, {})
      }
    };

    const upload = s3.upload(params);
    
    await upload.promise();
    const publicUrl = getPublicUrl(uniqueKey);
    
    // Clean up local file
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (unlinkError) {
      // Silently handle cleanup errors
    }
    
    return {
      publicUrl: publicUrl,
      mediaType: mediaType,
      fileName: uniqueKey,
      originalName: fileName,
      contentType: contentType,
      fileSize: fileContent.length,
      userMetadata: {
        userUid: userUid,
        followersDocId: followersDocId
      }
    };
  } catch (error) {
    // Clean up on error
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (unlinkError) {
      // Silently handle cleanup errors
    }
    throw error;
  }
}

// Multer configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, Date.now() + "-" + sanitized);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    // Images
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'image/bmp', 'image/tiff', 'image/x-icon', 'image/avif',
    // Videos
    'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
    'video/webm', 'video/x-flv', 'video/x-ms-wmv', 'video/x-m4v',
    'video/3gpp', 'video/ogg', 'video/mpeg',
    // Audio
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac',
    // Documents
    'application/pdf'
  ];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type: ' + file.mimetype + '. Supported: images, videos, audio, and PDFs.'), false);
  }
};

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: ENV.MAX_FILE_SIZE
  },
  fileFilter: fileFilter
});

// Single file upload endpoint with user metadata
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    
    // Extract user metadata from request body
    const userUid = req.body.userUid || req.query.userUid || '';
    const followersDocId = req.body.followersDocId || req.query.followersDocId || '';
    
    // Log the received metadata
    console.log('📋 Upload request received:');
    console.log('  📱 userUid:', userUid);
    console.log('  📄 followersDocId:', followersDocId);
    console.log('  📁 File:', req.file.originalname);
    
    const metadata = {
      'uploaded-by': req.body.userId || userUid || 'anonymous',
      'category': req.body.category || 'general',
      'description': req.body.description || '',
      'userUid': userUid,
      'followersDocId': followersDocId,
      // Include any additional fields from request body
      ...req.body
    };
    
    const result = await uploadToR2(req.file.path, req.file.filename, metadata);
    
    // Prepare response with all metadata
    const responseData = {
      success: true,
      publicUrl: result.publicUrl,
      mediaType: result.mediaType,
      message: "File uploaded successfully",
      metadata: {
        userUid: userUid,
        followersDocId: followersDocId,
        fileName: result.fileName,
        originalName: result.originalName,
        fileSize: result.fileSize,
        uploadDate: new Date().toISOString()
      }
    };
    
    // Log the response
    console.log('✅ Upload successful:');
    console.log('  🔗 URL:', result.publicUrl);
    console.log('  📱 userUid:', userUid);
    console.log('  📄 followersDocId:', followersDocId);
    
    res.json(responseData);
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkErr) {
        // Silently handle cleanup errors
      }
    }
    
    let errorMessage = error.message;
    if (error.code === 'InvalidAccessKeyId') {
      errorMessage = "Invalid R2 Access Key ID. Please check your credentials.";
    } else if (error.code === 'SignatureDoesNotMatch') {
      errorMessage = "Invalid R2 Secret Access Key. Please check your credentials.";
    } else if (error.code === 'NoSuchBucket') {
      errorMessage = `Bucket "${ENV.R2_BUCKET_NAME}" does not exist.`;
    } else if (error.code === 'NetworkingError') {
      errorMessage = "Network error. Please check your R2 endpoint URL.";
    }
    
    res.status(500).json({
      success: false,
      error: errorMessage,
      code: error.code || 'UNKNOWN_ERROR',
      metadata: {
        userUid: req.body.userUid || req.query.userUid || '',
        followersDocId: req.body.followersDocId || req.query.followersDocId || ''
      }
    });
  }
});

// Multiple files upload endpoint with user metadata
app.post("/upload-multiple", upload.array("files", 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }
    
    // Extract user metadata from request body
    const userUid = req.body.userUid || req.query.userUid || '';
    const followersDocId = req.body.followersDocId || req.query.followersDocId || '';
    
    console.log('📋 Multiple upload request:');
    console.log('  📱 userUid:', userUid);
    console.log('  📄 followersDocId:', followersDocId);
    console.log('  📁 Files:', req.files.length);
    
    const uploadPromises = req.files.map(file => 
      uploadToR2(file.path, file.filename, {
        'uploaded-by': req.body.userId || userUid || 'anonymous',
        'category': req.body.category || 'general',
        'userUid': userUid,
        'followersDocId': followersDocId
      })
    );
    
    const results = await Promise.all(uploadPromises);
    
    res.json({
      success: true,
      message: `${results.length} files uploaded successfully`,
      files: results.map(result => ({
        publicUrl: result.publicUrl,
        mediaType: result.mediaType,
        metadata: {
          userUid: result.userMetadata.userUid,
          followersDocId: result.userMetadata.followersDocId
        }
      })),
      metadata: {
        userUid: userUid,
        followersDocId: followersDocId
      }
    });
  } catch (error) {
    // Clean up remaining files
    if (req.files) {
      req.files.forEach(file => {
        if (fs.existsSync(file.path)) {
          try {
            fs.unlinkSync(file.path);
          } catch (unlinkErr) {
            // Silently handle cleanup errors
          }
        }
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || "Failed to upload files",
      metadata: {
        userUid: req.body.userUid || req.query.userUid || '',
        followersDocId: req.body.followersDocId || req.query.followersDocId || ''
      }
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    config: {
      maxFileSize: ENV.MAX_FILE_SIZE / 1024 / 1024 + 'MB'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'FILE_TOO_LARGE') {
      return res.status(413).json({ 
        error: `File too large. Maximum size is ${ENV.MAX_FILE_SIZE / 1024 / 1024}MB`,
        metadata: {
          userUid: req.body.userUid || req.query.userUid || '',
          followersDocId: req.body.followersDocId || req.query.followersDocId || ''
        }
      });
    }
    return res.status(400).json({ 
      error: err.message,
      metadata: {
        userUid: req.body.userUid || req.query.userUid || '',
        followersDocId: req.body.followersDocId || req.query.followersDocId || ''
      }
    });
  }
  res.status(500).json({ 
    error: "Internal server error",
    metadata: {
      userUid: req.body.userUid || req.query.userUid || '',
      followersDocId: req.body.followersDocId || req.query.followersDocId || ''
    }
  });
});

const PORT = ENV.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('🚀 Server is running on port', PORT);
  console.log('📁 Upload directory:', uploadDir);
  console.log('📦 Max file size:', ENV.MAX_FILE_SIZE / 1024 / 1024, 'MB');
  console.log('☁️  R2 Bucket:', ENV.R2_BUCKET_NAME);
  console.log('========================================\n');
});