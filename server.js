const path = require("path");
const express = require("express");
const multer = require("multer");
require("dotenv").config();
const {
  isDropboxConfigured,
  maxFileCount,
  maxFileSizeBytes,
  uploadSubmission,
  validateFiles
} = require("./lib/dropbox-upload");
const { handleUploadMiddlewareError, sendUploadError } = require("./lib/upload-response");

const app = express();
const staticDir = path.join(__dirname, "public");
const indexFile = path.join(staticDir, "index.html");
const supportedLanguageRoute = /^\/(?:(v1)\/)?(en|tr|al)(?:\/.*)?$/;
const unsupportedLanguageRoute = /^\/([a-z]{2,3})(?:\/.*)?$/i;
const unsupportedVersionBaseRoute = /^\/(v\d+)$/i;
const unsupportedVersionRoute = /^\/(v\d+)\/([a-z]{2,3})(?:\/.*)?$/i;

const port = Number(process.env.PORT || 3000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxFileSizeBytes,
    files: maxFileCount
  }
});

app.use(express.static(staticDir));
app.use("/:lang(en|tr|al)", express.static(staticDir));
app.use("/v1/:lang(en|tr|al)", express.static(staticDir));

app.post("/api/photos/upload", upload.array("photos", maxFileCount), async (req, res) => {
  if (!isDropboxConfigured()) {
    return sendUploadError(res, 503, "Dropbox is not configured.");
  }

  try {
    const files = req.files || [];
    const guestName = (req.body?.guestName || "").trim();
    const message = (req.body?.message || "").trim();
    const validationError = validateFiles(files);

    if (validationError) {
      return sendUploadError(res, 400, validationError);
    }

    const { submissionId } = await uploadSubmission({ files, guestName, message });
    return res.status(200).json({
      ok: true,
      submissionId
    });
  } catch (error) {
    console.error("Upload route error:", error);
    return res.status(500).json({ error: "Upload failed." });
  }
});

app.get(supportedLanguageRoute, (_req, res) => {
  res.sendFile(indexFile);
});

app.get(unsupportedVersionBaseRoute, (req, res) => {
  const [, version] = req.path.match(unsupportedVersionBaseRoute) || [];
  if (String(version).toLowerCase() === "v1") {
    return res.redirect(302, "/v1/en");
  }
  return res.redirect(302, "/en");
});

app.get(unsupportedVersionRoute, (req, res) => {
  const [, version, language] = req.path.match(unsupportedVersionRoute) || [];
  if (String(version).toLowerCase() !== "v1") {
    const safeLang = ["en", "tr", "al"].includes(String(language).toLowerCase()) ? String(language).toLowerCase() : "en";
    return res.redirect(302, `/${safeLang}`);
  }

  return res.redirect(302, "/v1/en");
});

app.get(unsupportedLanguageRoute, (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  return res.redirect(302, "/en");
});

app.use((error, _req, res, _next) => {
  if (handleUploadMiddlewareError(error, res)) {
    return;
  }
  console.error("Unhandled server error:", error);
  return sendUploadError(res, 500, "Server error.");
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
