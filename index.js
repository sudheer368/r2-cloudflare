const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');
const axios = require('axios');
const FormData = require('form-data');

// Initialize app first
const app = express();

// Extend EventEmitter for progress tracking
class ProgressEmitter extends EventEmitter {}
const progressEmitter = new ProgressEmitter();

// Store progress data
const progressStore = new Map();

// Cloudflare R2 configuration
const R2_UPLOAD_URL = 'https://r2-cloudflare.onrender.com/upload';

// Try to use ffmpeg-installer, fallback to system ffmpeg
try {
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  console.log('Using FFmpeg from:', ffmpegInstaller.path);
} catch (error) {
  console.log('ffmpeg-installer not found, using system FFmpeg');
  try {
    const which = require('which');
    const ffmpegPath = which.sync('ffmpeg');
    ffmpeg.setFfmpegPath(ffmpegPath);
    console.log('Found system FFmpeg at:', ffmpegPath);
  } catch (e) {
    console.error('FFmpeg not found. Please install FFmpeg');
    process.exit(1);
  }
}

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Check available disk space
const checkDiskSpace = () => {
  try {
    const stats = fs.statSync('/');
    const freeSpace = stats.bfree * stats.bsize;
    const freeSpaceGB = freeSpace / (1024 * 1024 * 1024);
    console.log(`Available disk space: ${freeSpaceGB.toFixed(2)} GB`);
    return freeSpaceGB;
  } catch (error) {
    console.warn('Could not check disk space:', error.message);
    return 20; // Assume 20GB available
  }
};

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

// Configure multer with 5GB limit
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024, // 5GB
    fieldSize: 5 * 1024 * 1024 * 1024,
    fields: 10,
    files: 1
  }
});

// Function to upload file to Cloudflare R2 with detailed logging
const uploadToR2 = async (filePath, fileName) => {
  try {
    console.log('\n📤 ========== STARTING R2 UPLOAD ==========');
    console.log('📁 File path:', filePath);
    console.log('📄 File name:', fileName);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    const fileStats = fs.statSync(filePath);
    const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);
    const fileSizeGB = (fileStats.size / (1024 * 1024 * 1024)).toFixed(2);
    console.log(`📊 File size: ${fileSizeMB} MB (${fileSizeGB} GB)`);
    
    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath), fileName);
    
    console.log('🌐 Sending request to:', R2_UPLOAD_URL);
    console.log('⏳ Uploading... (this may take a while for large files)');
    
    const startTime = Date.now();
    
    const response = await axios.post(R2_UPLOAD_URL, formData, {
      headers: {
        ...formData.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 600000, // 10 minutes timeout for large files
      onUploadProgress: (progressEvent) => {
        const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
        if (percentCompleted % 10 === 0) {
          console.log(`📊 Upload progress: ${percentCompleted}%`);
        }
      }
    });
    
    const endTime = Date.now();
    const uploadTime = ((endTime - startTime) / 1000).toFixed(2);
    
    console.log('✅ Upload completed in', uploadTime, 'seconds');
    console.log('📦 Response status:', response.status);
    console.log('📦 Response data:', JSON.stringify(response.data, null, 2));
    
    // Detailed response logging
    if (response.data) {
      console.log('\n📋 ========== R2 UPLOAD RESPONSE DETAILS ==========');
      console.log('✅ Success:', response.data.success);
      console.log('📝 Message:', response.data.message);
      console.log('🔗 Public URL:', response.data.publicUrl);
      console.log('📁 Media Type:', response.data.mediaType);
      console.log('📄 File Name:', response.data.fileName || fileName);
      
      // Log additional fields if present
      if (response.data.bucket) console.log('🪣 Bucket:', response.data.bucket);
      if (response.data.key) console.log('🔑 Key:', response.data.key);
      if (response.data.etag) console.log('🏷️ ETag:', response.data.etag);
      if (response.data.size) console.log('📊 Uploaded Size:', response.data.size);
      
      console.log('=================================================\n');
    }
    
    return response.data;
  } catch (error) {
    console.error('\n❌ ========== R2 UPLOAD FAILED ==========');
    console.error('Error message:', error.message);
    
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }
    
    if (error.request) {
      console.error('No response received from server');
    }
    
    console.error('==========================================\n');
    throw new Error(`R2 upload failed: ${error.message}`);
  }
};

// Cleanup function for old files
const cleanupOldFiles = (directory, maxAgeHours = 24) => {
  const now = Date.now();
  const maxAge = maxAgeHours * 60 * 60 * 1000;
  
  fs.readdir(directory, (err, files) => {
    if (err) return;
    
    files.forEach(file => {
      const filePath = path.join(directory, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        const fileAge = now - stats.mtime.getTime();
        if (fileAge > maxAge) {
          fs.unlink(filePath, () => {});
          console.log('Cleaned up old file:', file);
        }
      });
    });
  });
};

// Run cleanup every hour
setInterval(() => {
  cleanupOldFiles('uploads', 24);
}, 60 * 60 * 1000);

// Get video duration using ffprobe
const getVideoDuration = (inputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        const duration = metadata.format.duration || 0;
        resolve(duration);
      }
    });
  });
};

// Enhanced compression with R2 upload
const compressAndUploadVideo = async (inputPath, outputPath, res, req, originalFileName) => {
  console.log('\n=== Starting Compression and Upload ===');
  console.log('Input:', inputPath);
  console.log('Output:', outputPath);
  
  // Get input file size
  let inputSize = 0;
  try {
    const stats = fs.statSync(inputPath);
    inputSize = stats.size;
    const sizeGB = (inputSize / (1024 * 1024 * 1024)).toFixed(2);
    const sizeMB = (inputSize / (1024 * 1024)).toFixed(2);
    console.log(`Input file size: ${sizeMB} MB (${sizeGB} GB)`);
    
    // Check if we have enough disk space
    const freeSpace = checkDiskSpace();
    const neededSpace = (inputSize * 2) / (1024 * 1024 * 1024);
    if (freeSpace < neededSpace) {
      return res.status(507).json({
        error: 'Insufficient disk space',
        message: `Need at least ${neededSpace.toFixed(2)}GB free, have ${freeSpace.toFixed(2)}GB`
      });
    }
  } catch (error) {
    console.warn('Could not read input file size:', error.message);
  }

  // Get video duration
  let videoDuration = 0;
  try {
    videoDuration = await getVideoDuration(inputPath);
    console.log(`Video duration: ${videoDuration.toFixed(2)} seconds`);
  } catch (error) {
    console.warn('Could not get video duration:', error.message);
  }

  // Adjust compression settings based on file size
  const isLargeFile = inputSize > 1 * 1024 * 1024 * 1024; // > 1GB
  const jobId = Date.now().toString();
  
  // Store initial progress
  progressStore.set(jobId, {
    percent: 0,
    time: '00:00:00',
    status: 'processing',
    phase: 'compression'
  });

  // Create a more aggressive compression for very large files
  let videoBitrate = '1500k';
  let audioBitrate = '128k';
  let scale = 'iw*0.5:ih*0.5';
  
  if (inputSize > 4 * 1024 * 1024 * 1024) { // > 4GB
    videoBitrate = '1000k';
    scale = 'iw*0.3:ih*0.3';
    console.log('Using extra aggressive compression for very large file');
  } else if (inputSize > 2 * 1024 * 1024 * 1024) { // > 2GB
    videoBitrate = '1200k';
    scale = 'iw*0.4:ih*0.4';
    console.log('Using aggressive compression for large file');
  }

  ffmpeg(inputPath)
    .output(outputPath)
    .videoCodec('libx264')
    .audioCodec('aac')
    .outputOptions([
      '-movflags +faststart',
      isLargeFile ? '-preset ultrafast' : '-preset medium',
      '-crf 28',
      `-vf scale=${scale}`,
      `-b:v ${videoBitrate}`,
      '-maxrate 2000k',
      '-bufsize 4000k',
      `-b:a ${audioBitrate}`,
      '-ac 2',
      '-threads ' + os.cpus().length
    ])
    .on('start', (commandLine) => {
      console.log('FFmpeg command:', commandLine);
      console.log(`Using ${os.cpus().length} CPU cores`);
    })
    .on('progress', (progress) => {
      // Calculate progress more accurately
      let percent = 0;
      if (videoDuration > 0) {
        const parts = progress.timemark.split(':').map(Number);
        const currentSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        percent = Math.min(100, (currentSeconds / videoDuration) * 100);
      } else {
        percent = Math.round(progress.percent || 0);
      }
      
      const currentTime = progress.timemark || '00:00:00';
      console.log(`Compression Progress: ${percent.toFixed(1)}% done (${currentTime})`);
      
      // Store progress data
      progressStore.set(jobId, {
        percent: percent,
        time: currentTime,
        status: 'processing',
        phase: 'compression'
      });
      
      // Emit progress event
      progressEmitter.emit('progress', jobId, percent, currentTime);
    })
    .on('end', async () => {
      console.log('✅ Compression completed!');
      
      // Update progress for upload phase
      progressStore.set(jobId, {
        percent: 100,
        time: '00:00:00',
        status: 'processing',
        phase: 'uploading'
      });
      
      try {
        // Get compressed file info
        const stats = fs.statSync(outputPath);
        const compressedSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        const compressedSizeGB = (stats.size / (1024 * 1024 * 1024)).toFixed(2);
        const compressionRatio = ((stats.size / inputSize) * 100).toFixed(2);
        
        console.log(`Compressed size: ${compressedSizeMB} MB (${compressedSizeGB} GB)`);
        console.log(`Compression ratio: ${compressionRatio}% of original`);
        
        // Upload to Cloudflare R2
        const fileName = `compressed_${Date.now()}_${path.basename(originalFileName)}`;
        const uploadResult = await uploadToR2(outputPath, fileName);
        
        // Log the full upload result
        console.log('\n📦 ========== FULL UPLOAD RESULT ==========');
        console.log(JSON.stringify(uploadResult, null, 2));
        console.log('==========================================\n');
        
        // Log specific fields
        if (uploadResult.publicUrl) {
          console.log('🔗 PUBLIC URL:', uploadResult.publicUrl);
        }
        if (uploadResult.mediaType) {
          console.log('📁 MEDIA TYPE:', uploadResult.mediaType);
        }
        
        // Update progress - completed
        progressStore.set(jobId, {
          percent: 100,
          time: '00:00:00',
          status: 'completed',
          phase: 'completed'
        });
        
        // Clean up local files
        try {
          fs.unlinkSync(inputPath);
          fs.unlinkSync(outputPath);
          console.log('Local files cleaned up');
        } catch (err) {
          console.error('Error deleting local files:', err);
        }
        
        // Send success response with R2 file info
        const responseData = {
          success: true,
          message: 'Video compressed and uploaded successfully!',
          jobId: jobId,
          compression: {
            originalSize: `${(inputSize / (1024 * 1024 * 1024)).toFixed(2)} GB`,
            compressedSize: `${compressedSizeMB} MB (${compressedSizeGB} GB)`,
            compressionRatio: `${compressionRatio}%`
          },
          upload: {
            status: 'success',
            fileName: fileName,
            r2Response: uploadResult
          }
        };
        
        console.log('\n📤 ========== SENDING RESPONSE ==========');
        console.log(JSON.stringify(responseData, null, 2));
        console.log('======================================\n');
        
        res.json(responseData);
        
      } catch (error) {
        console.error('❌ Upload failed:', error);
        
        progressStore.set(jobId, {
          percent: 0,
          time: '00:00:00',
          status: 'failed',
          phase: 'upload_failed'
        });
        
        // Clean up files
        try {
          if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        } catch (e) {}
        try {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch (e) {}
        
        res.status(500).json({
          error: 'Upload to R2 failed',
          message: error.message,
          jobId: jobId
        });
      }
    })
    .on('error', (err) => {
      console.error('❌ Compression failed:', err);
      
      // Update progress
      progressStore.set(jobId, {
        percent: 0,
        time: '00:00:00',
        status: 'failed',
        phase: 'compression_failed'
      });
      
      // Clean up files
      try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      } catch (e) {}
      try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch (e) {}
      
      res.status(500).json({
        error: 'Compression failed',
        message: err.message,
        jobId: jobId
      });
    })
    .run();
};

// ============== ROUTES ==============

// Progress endpoint
app.get('/progress/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const progress = progressStore.get(jobId);
  
  if (!progress) {
    return res.status(404).json({
      error: 'Job not found',
      message: 'No compression job found with this ID'
    });
  }
  
  res.json({
    jobId: jobId,
    progress: progress
  });
});

// Upload endpoint with compression and R2 upload
app.post('/upload', (req, res) => {
  console.log('\n=== New Upload Request ===');
  
  upload.any()(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err);
      
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'File too large',
          message: 'Maximum file size is 5GB'
        });
      }
      
      return res.status(500).json({
        error: 'Upload failed',
        message: err.message
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'No file uploaded',
        message: 'Please upload a video file'
      });
    }
    
    const file = req.files[0];
    const sizeGB = (file.size / (1024 * 1024 * 1024)).toFixed(2);
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    
    console.log('File received:', file.originalname);
    console.log(`Size: ${sizeMB} MB (${sizeGB} GB)`);
    console.log('Field name:', file.fieldname);
    console.log('MIME type:', file.mimetype);
    
    const videoPath = file.path;
    const outputFileName = `compressed_${file.filename}.mp4`;
    const outputFilePath = path.join('uploads', outputFileName);
    
    // Start compression and upload
    compressAndUploadVideo(videoPath, outputFilePath, res, req, file.originalname);
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const freeSpace = checkDiskSpace();
  const uploadDir = 'uploads';
  let fileCount = 0;
  try {
    fileCount = fs.readdirSync(uploadDir).length;
  } catch (e) {}
  
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    diskSpace: `${freeSpace.toFixed(2)} GB free`,
    uploadDirectory: uploadDir,
    filesInUploadDir: fileCount,
    maxFileSize: '5GB',
    activeJobs: progressStore.size,
    r2Endpoint: R2_UPLOAD_URL
  });
});

// Cleanup old files manually
app.post('/cleanup', (req, res) => {
  const files = fs.readdirSync('uploads');
  let deleted = 0;
  
  files.forEach(file => {
    const filePath = path.join('uploads', file);
    try {
      fs.unlinkSync(filePath);
      deleted++;
    } catch (err) {
      console.error('Error deleting:', filePath, err);
    }
  });
  
  res.json({
    success: true,
    message: `Cleaned up ${deleted} files`,
    totalFiles: files.length
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Server error',
    message: err.message
  });
});

// ============== SERVER STARTUP ==============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('🚀 Server is running on port', PORT);
  console.log('📁 Upload directory: uploads/');
  console.log('📦 Max file size: 5GB');
  console.log('💻 CPU Cores:', os.cpus().length);
  console.log('🔄 Cleanup runs every hour');
  console.log('📊 Progress tracking enabled');
  console.log('☁️  R2 Upload URL:', R2_UPLOAD_URL);
  console.log('========================================\n');
  
  // Check disk space on startup
  checkDiskSpace();
});

// Export for testing
module.exports = { app, progressStore, progressEmitter };