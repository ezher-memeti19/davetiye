const multer = require("multer");

function sendUploadError(res, statusCode, message) {
  return res.status(statusCode).json({ error: message });
}

function handleUploadMiddlewareError(error, res) {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return sendUploadError(res, 400, "One or more files exceed the size limit.");
    }
    if (error.code === "LIMIT_FILE_COUNT") {
      return sendUploadError(res, 400, "Too many files uploaded.");
    }
    return sendUploadError(res, 400, "Invalid upload request.");
  }

  return null;
}

module.exports = {
  handleUploadMiddlewareError,
  sendUploadError
};
