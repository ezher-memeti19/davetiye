const multer = require("multer");
const {
  isDropboxConfigured,
  maxFileCount,
  maxFileSizeBytes,
  uploadSubmission,
  validateFiles
} = require("../../lib/dropbox-upload");
const { handleUploadMiddlewareError, sendUploadError } = require("../../lib/upload-response");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxFileSizeBytes,
    files: maxFileCount
  }
});

function runMiddleware(req, res, middleware) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (result) => {
      if (result instanceof Error) {
        reject(result);
        return;
      }
      resolve(result);
    });
  });
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendUploadError(res, 405, "Method not allowed.");
  }

  if (!isDropboxConfigured()) {
    return sendUploadError(res, 503, "Dropbox is not configured.");
  }

  try {
    await runMiddleware(req, res, upload.array("photos", maxFileCount));

    const files = req.files || [];
    const guestName = (req.body?.guestName || "").trim();
    const message = (req.body?.message || "").trim();
    const validationError = validateFiles(files);

    if (validationError) {
      return sendUploadError(res, 400, validationError);
    }

    const { submissionId } = await uploadSubmission({ files, guestName, message });
    return res.status(200).json({ ok: true, submissionId });
  } catch (error) {
    if (handleUploadMiddlewareError(error, res)) {
      return;
    }

    console.error("Upload route error:", error);
    return sendUploadError(res, 500, "Upload failed.");
  }
}

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false
  }
};
