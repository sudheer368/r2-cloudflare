const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const AWS = require("aws-sdk");
const crypto = require("crypto");
const { exec } = require('child_process');
const util = require('util');
const axios = require('axios');
const execPromise = util.promisify(exec);

const app = express();

// Environment variables
const ENV = {
  R2_ENDPOINT: "https://8d6d71696c62d814030a8b94486298a6.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "a708c3b8ea970da1adb0cc4cb3822a74",
  R2_SECRET_ACCESS_KEY: "b9e9376fc15ffb2c6a16c1fee5e61a6b100abee555b79c18bde0a2d8db1cace0",
  R2_BUCKET_NAME: "timeline",
  R2_ACCOUNT_ID: "9074667375914ae7aa1345f9e0d9a0a5",
  PORT: 3000,
  MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB for videos
  STATUS_API_URL: "https://us-central1-kiran-interior-b7e9c.cloudfunctions.net/mediafileupload/status"
};

// ============================================
// 🚀 CORS CONFIGURATION - Enable Cross-Origin Access
// ============================================
const corsOptions = {
  origin: '*', // For development - allow all origins
  // For production, use specific origins:
  // origin: ['https://yourdomain.com', 'https://app.yourdomain.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Accept',
    'Origin',
    'X-Requested-With',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
    'X-CSRF-Token'
  ],
  exposedHeaders: [
    'Content-Length',
    'Content-Type',
    'X-Upload-Id',
    'X-R2-URL'
  ],
  credentials: true,
  maxAge: 86400 // 24 hours
};

// CORS Middleware - Must be before all routes
app.use((req, res, next) => {
  // Set CORS headers for all responses
  const origin = req.headers.origin || '*';
  
  // For development, allow all origins
  // For production, validate origin here
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', corsOptions.methods.join(', '));
  res.header('Access-Control-Allow-Headers', corsOptions.allowedHeaders.join(', '));
  res.header('Access-Control-Expose-Headers', corsOptions.exposedHeaders.join(', '));
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', corsOptions.maxAge.toString());

  // Handle preflight requests (OPTIONS)
  if (req.method === 'OPTIONS') {
    // Respond with 200 for OPTIONS requests
    return res.status(200).json({
      message: 'CORS preflight successful',
      allowedOrigins: corsOptions.origin,
      allowedMethods: corsOptions.methods,
      allowedHeaders: corsOptions.allowedHeaders
    });
  }

  next();
});

// Alternative: Use npm package 'cors' (uncomment if you prefer)
/*
const cors = require('cors');
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true,
  maxAge: 86400
}));
*/

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

// Check if file is a video
const isVideoFile = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.ogv', '.mpeg'];
  return videoExts.includes(ext);
};

// Get video duration using ffprobe (if available) or fallback to ffmpeg
async function getVideoDuration(filePath) {
  try {
    // Try using ffprobe first (more reliable)
    try {
      const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
      const duration = parseFloat(stdout.trim());
      if (!isNaN(duration) && duration > 0) {
        return duration;
      }
    } catch (ffprobeError) {
      // ffprobe failed, try ffmpeg
      console.log('ffprobe not found, trying ffmpeg...');
    }
    
    // Fallback to ffmpeg
    try {
      const { stdout } = await execPromise(`ffmpeg -i "${filePath}" 2>&1 | grep "Duration" | awk '{print $2}' | tr -d ,`);
      const durationStr = stdout.trim();
      if (durationStr) {
        // Parse duration in format HH:MM:SS.milliseconds
        const parts = durationStr.split(':');
        if (parts.length === 3) {
          const hours = parseFloat(parts[0]);
          const minutes = parseFloat(parts[1]);
          const seconds = parseFloat(parts[2]);
          const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
          if (!isNaN(totalSeconds) && totalSeconds > 0) {
            return totalSeconds;
          }
        }
      }
    } catch (ffmpegError) {
      console.log('ffmpeg not found or failed to get duration');
    }
    
    // If we can't get duration, return 0
    return 0;
  } catch (error) {
    console.error('Error getting video duration:', error.message);
    return 0;
  }
}

// Format duration to human readable format
const formatDuration = (seconds) => {
  if (!seconds || seconds === 0) return '0s';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  let result = '';
  if (hours > 0) {
    result += `${hours}h `;
  }
  if (minutes > 0) {
    result += `${minutes}m `;
  }
  if (secs > 0 || result === '') {
    result += `${secs}s`;
  }
  
  return result.trim();
};

// Generate public URL for the file
const getPublicUrl = (fileName) => {
  return `https://pub-${ENV.R2_ACCOUNT_ID}.r2.dev/${fileName}`;
};

// Call status API after successful upload
async function callStatusAPI(statusData) {
  try {
    console.log('\n📡 ========== CALLING STATUS API ==========');
    console.log('  🌐 URL:', ENV.STATUS_API_URL);
    console.log('  📦 Data:', JSON.stringify(statusData, null, 2));
    
    const response = await axios.post(ENV.STATUS_API_URL, statusData, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 seconds timeout
    });
    
    console.log('✅ Status API Response:', response.status, response.statusText);
    console.log('📦 Response Data:', JSON.stringify(response.data, null, 2));
    console.log('==========================================\n');
    
    return response.data;
  } catch (error) {
    console.error('❌ Status API call failed:');
    if (error.response) {
      console.error('  Status:', error.response.status);
      console.error('  Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('  No response received from server');
    } else {
      console.error('  Error:', error.message);
    }
    console.log('==========================================\n');
    throw error;
  }
}

// Upload function with user metadata and video duration
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
    
    // Get video duration if it's a video file
    let videoDuration = 0;
    let formattedDuration = '0s';
    let durationSeconds = 0;
    
    if (isVideoFile(fileName)) {
      console.log('🎬 Getting video duration for:', fileName);
      videoDuration = await getVideoDuration(filePath);
      durationSeconds = Math.round(videoDuration); // Round to nearest second
      formattedDuration = formatDuration(videoDuration);
      console.log(`⏱️ Video duration: ${durationSeconds}s (${formattedDuration})`);
    }
    
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
        'video-duration-seconds': durationSeconds.toString(),
        'video-duration-formatted': formattedDuration,
        'caption': metadata.caption || '',
        'visible': metadata.visible || 'followers',
        // Include all other metadata
        ...Object.keys(metadata).reduce((acc, key) => {
          if (!['userUid', 'followersDocId', 'caption', 'visible'].includes(key)) {
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
        followersDocId: followersDocId,
        caption: metadata.caption || '',
        visible: metadata.visible || 'followers'
      },
      videoDuration: {
        seconds: durationSeconds,
        formatted: formattedDuration
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

// ============================================
// 📡 CORS TEST ENDPOINT
// ============================================
app.get("/cors-test", (req, res) => {
  res.json({
    success: true,
    message: "CORS is enabled!",
    timestamp: new Date().toISOString(),
    headers: {
      'Access-Control-Allow-Origin': res.getHeaders()['access-control-allow-origin'] || '*',
      'Access-Control-Allow-Methods': res.getHeaders()['access-control-allow-methods'] || 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': res.getHeaders()['access-control-allow-headers'] || 'Content-Type, Accept'
    },
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      endpoint: ENV.R2_ENDPOINT,
      bucket: ENV.R2_BUCKET_NAME
    }
  });
});

// ============================================
// 📤 SINGLE FILE UPLOAD ENDPOINT
// ============================================
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    
    // Extract user metadata from request body
    const userUid = req.body.userUid || req.query.userUid || '';
    const followersDocId = req.body.followersDocId || req.query.followersDocId || '';
    const caption = req.body.caption || req.query.caption || '';
    const visible = req.body.visible || req.query.visible || 'followers';
    
    // Log the received metadata
    console.log('\n📋 ========== UPLOAD REQUEST ==========');
    console.log('  📱 userUid:', userUid);
    console.log('  📄 followersDocId:', followersDocId);
    console.log('  📁 File:', req.file.originalname);
    console.log('  📊 File size:', (req.file.size / 1024 / 1024).toFixed(2), 'MB');
    console.log('  📝 Caption:', caption);
    console.log('  👁️ Visible:', visible);
    console.log('  🌐 Origin:', req.headers.origin || 'Unknown');
    
    const metadata = {
      'uploaded-by': req.body.userId || userUid || 'anonymous',
      'category': req.body.category || 'general',
      'description': req.body.description || '',
      'userUid': userUid,
      'followersDocId': followersDocId,
      'caption': caption,
      'visible': visible,
      // Include any additional fields from request body
      ...req.body
    };
    
    const result = await uploadToR2(req.file.path, req.file.filename, metadata);
    
    // Prepare status API data
    const statusData = {
      useruid: userUid || '',
      statusurl: result.publicUrl,
      mediaType: result.mediaType,
      visible: visible || '',
      caption: caption || '',
      followersdocid: followersDocId || '',
      duration: result.videoDuration.seconds.toString(),
      ss: 's'
    };
    
    // Call status API
    let statusApiResponse = null;
    try {
      statusApiResponse = await callStatusAPI(statusData);
    } catch (error) {
      console.error('⚠️ Status API call failed but upload was successful');
      // Continue with response even if status API fails
    }
    
    // Prepare response with all metadata
    const responseData = {
      success: true,
      publicUrl: result.publicUrl,
      mediaType: result.mediaType,
      message: "File uploaded successfully",
      metadata: {
        userUid: userUid,
        followersDocId: followersDocId,
        caption: caption,
        visible: visible,
        fileName: result.fileName,
        originalName: result.originalName,
        fileSize: result.fileSize,
        fileSizeMB: (result.fileSize / 1024 / 1024).toFixed(2) + ' MB',
        uploadDate: new Date().toISOString()
      },
      statusApi: statusApiResponse ? {
        called: true,
        success: true,
        response: statusApiResponse
      } : {
        called: false,
        success: false,
        message: 'Status API call failed'
      }
    };
    
    // Add video duration if it's a video
    if (result.videoDuration && result.videoDuration.seconds > 0) {
      responseData.metadata.videoDuration = {
        seconds: result.videoDuration.seconds,
        formatted: result.videoDuration.formatted,
        minutes: (result.videoDuration.seconds / 60).toFixed(2),
        hours: (result.videoDuration.seconds / 3600).toFixed(2)
      };
    }
    
    // Log the response
    console.log('✅ ========== UPLOAD SUCCESS ==========');
    console.log('  🔗 URL:', result.publicUrl);
    console.log('  📱 userUid:', userUid);
    console.log('  📄 followersDocId:', followersDocId);
    if (result.videoDuration && result.videoDuration.seconds > 0) {
      console.log('  ⏱️ Duration:', result.videoDuration.formatted);
    }
    console.log('  📡 Status API:', statusApiResponse ? '✅ Called successfully' : '❌ Failed');
    console.log('========================================\n');
    
    // Add CORS headers to response
    res.header('X-Upload-Id', result.fileName);
    res.header('X-R2-URL', result.publicUrl);
    
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
    let statusCode = 500;
    
    if (error.code === 'InvalidAccessKeyId') {
      errorMessage = "Invalid R2 Access Key ID. Please check your credentials.";
      statusCode = 401;
    } else if (error.code === 'SignatureDoesNotMatch') {
      errorMessage = "Invalid R2 Secret Access Key. Please check your credentials.";
      statusCode = 401;
    } else if (error.code === 'NoSuchBucket') {
      errorMessage = `Bucket "${ENV.R2_BUCKET_NAME}" does not exist.`;
      statusCode = 404;
    } else if (error.code === 'NetworkingError') {
      errorMessage = "Network error. Please check your R2 endpoint URL.";
      statusCode = 503;
    }
    
    res.status(statusCode).json({
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

// ============================================
// 📤 MULTIPLE FILES UPLOAD ENDPOINT
// ============================================
app.post("/upload-multiple", upload.array("files", 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }
    
    // Extract user metadata from request body
    const userUid = req.body.userUid || req.query.userUid || '';
    const followersDocId = req.body.followersDocId || req.query.followersDocId || '';
    const caption = req.body.caption || req.query.caption || '';
    const visible = req.body.visible || req.query.visible || 'followers';
    
    console.log('\n📋 ========== MULTIPLE UPLOAD REQUEST ==========');
    console.log('  📱 userUid:', userUid);
    console.log('  📄 followersDocId:', followersDocId);
    console.log('  📁 Files:', req.files.length);
    console.log('  📝 Caption:', caption);
    console.log('  👁️ Visible:', visible);
    console.log('  🌐 Origin:', req.headers.origin || 'Unknown');
    
    const uploadPromises = req.files.map(file => 
      uploadToR2(file.path, file.filename, {
        'uploaded-by': req.body.userId || userUid || 'anonymous',
        'category': req.body.category || 'general',
        'userUid': userUid,
        'followersDocId': followersDocId,
        'caption': caption,
        'visible': visible
      })
    );
    
    const results = await Promise.all(uploadPromises);
    
    // Calculate total video duration
    let totalDuration = 0;
    const fileDetails = results.map(result => {
      const fileData = {
        publicUrl: result.publicUrl,
        mediaType: result.mediaType,
        metadata: {
          userUid: result.userMetadata.userUid,
          followersDocId: result.userMetadata.followersDocId,
          caption: result.userMetadata.caption,
          visible: result.userMetadata.visible
        }
      };
      
      if (result.videoDuration && result.videoDuration.seconds > 0) {
        fileData.videoDuration = {
          seconds: result.videoDuration.seconds,
          formatted: result.videoDuration.formatted
        };
        totalDuration += result.videoDuration.seconds;
      }
      
      return fileData;
    });
    
    // Call status API for each file
    const statusApiResults = [];
    for (const result of results) {
      try {
        const statusData = {
          useruid: userUid || 'sudheer',
          statusurl: result.publicUrl,
          mediaType: result.mediaType,
          visible: visible || 'followers',
          caption: caption || 'Good Morning',
          followersdocid: followersDocId || 'followers123',
          duration: result.videoDuration.seconds.toString(),
          ss: 's'
        };
        
        const statusResponse = await callStatusAPI(statusData);
        statusApiResults.push({
          file: result.originalName,
          success: true,
          response: statusResponse
        });
      } catch (error) {
        statusApiResults.push({
          file: result.originalName,
          success: false,
          error: error.message
        });
      }
    }
    
    console.log('✅ ========== UPLOAD SUCCESS ==========');
    console.log('  📁 Files uploaded:', results.length);
    if (totalDuration > 0) {
      console.log('  ⏱️ Total duration:', formatDuration(totalDuration));
    }
    console.log('  📡 Status API calls:', statusApiResults.filter(r => r.success).length, 'successful');
    console.log('========================================\n');
    
    res.json({
      success: true,
      message: `${results.length} files uploaded successfully`,
      files: fileDetails,
      metadata: {
        userUid: userUid,
        followersDocId: followersDocId,
        caption: caption,
        visible: visible,
        totalFiles: results.length,
        totalDuration: totalDuration > 0 ? {
          seconds: totalDuration,
          formatted: formatDuration(totalDuration)
        } : undefined
      },
      statusApi: {
        called: true,
        totalCalls: statusApiResults.length,
        successfulCalls: statusApiResults.filter(r => r.success).length,
        results: statusApiResults
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

// ============================================
// 🏥 HEALTH CHECK ENDPOINT
// ============================================
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    config: {
      maxFileSize: ENV.MAX_FILE_SIZE / 1024 / 1024 + 'MB',
      supportedFormats: ['images', 'videos', 'audio', 'PDFs'],
      statusApiUrl: ENV.STATUS_API_URL
    },
    cors: {
      enabled: true,
      allowedOrigins: corsOptions.origin,
      allowedMethods: corsOptions.methods,
      allowedHeaders: corsOptions.allowedHeaders
    }
  });
});

// ============================================
// ❌ ERROR HANDLING MIDDLEWARE
// ============================================
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

// ============================================
// 🚀 START SERVER
// ============================================
const PORT = ENV.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('🚀 Server is running on port', PORT);
  console.log('📁 Upload directory:', uploadDir);
  console.log('📦 Max file size:', ENV.MAX_FILE_SIZE / 1024 / 1024, 'MB');
  console.log('☁️  R2 Bucket:', ENV.R2_BUCKET_NAME);
  console.log('🎬 Video duration detection: Enabled');
  console.log('📹 Supported video formats: MP4, MOV, AVI, MKV, WEBM, FLV, WMV, M4V, 3GP, OGV, MPEG');
  console.log('📡 Status API URL:', ENV.STATUS_API_URL);
  console.log('\n🌐 CORS Configuration:');
  console.log('  ✅ Allowed Origins:', corsOptions.origin);
  console.log('  ✅ Allowed Methods:', corsOptions.methods.join(', '));
  console.log('  ✅ Allowed Headers:', corsOptions.allowedHeaders.join(', '));
  console.log('  ✅ Max Age:', corsOptions.maxAge, 'seconds');
  console.log('\n📡 Test CORS: GET /cors-test');
  console.log('========================================\n');
});