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
const supportedLanguages = new Set(["en", "tr", "al"]);
const supportedVariants = new Set(["v1", "v2"]);

const port = Number(process.env.PORT || 3000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxFileSizeBytes,
    files: maxFileCount
  }
});

app.use(express.static(staticDir, { index: false, redirect: false }));

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

app.get(/^\/(en|tr|al)\/(v1|v2)(?:\/(.*))?\/?$/i, (req, res) => {
  const [, lang, variant, tail] = req.path.match(/^\/(en|tr|al)\/(v1|v2)(?:\/(.*))?\/?$/i) || [];
  const suffix = tail ? `/${tail}` : "";
  return res.redirect(302, `/${String(variant).toLowerCase()}/${String(lang).toLowerCase()}${suffix}`);
});

app.get(/^\/(v1|v2)\/?$/i, (req, res) => {
  const [, variant] = req.path.match(/^\/(v1|v2)\/?$/i) || [];
  return res.redirect(302, `/${String(variant).toLowerCase()}/en`);
});

app.get(/^\/(v1|v2)\/([^/]+)(?:\/(.*))?\/?$/i, (req, res) => {
  const [, variant, language, tail] = req.path.match(/^\/(v1|v2)\/([^/]+)(?:\/(.*))?\/?$/i) || [];
  const normalizedVariant = String(variant).toLowerCase();
  const normalizedLanguage = String(language).toLowerCase();
  const suffix = tail ? `/${tail}` : "";

  if (!supportedVariants.has(normalizedVariant)) {
    const safeLang = supportedLanguages.has(normalizedLanguage) ? normalizedLanguage : "en";
    return res.redirect(302, `/${safeLang}${suffix}`);
  }

  if (!supportedLanguages.has(normalizedLanguage)) {
    return res.redirect(302, `/${normalizedVariant}/en${suffix}`);
  }

  return res.sendFile(indexFile);
});

app.get(/^\/(v\d+)\/([^/]+)(?:\/(.*))?\/?$/i, (req, res) => {
  const [, _variant, language, tail] = req.path.match(/^\/(v\d+)\/([^/]+)(?:\/(.*))?\/?$/i) || [];
  const safeLang = supportedLanguages.has(String(language).toLowerCase()) ? String(language).toLowerCase() : "en";
  const suffix = tail ? `/${tail}` : "";
  return res.redirect(302, `/${safeLang}${suffix}`);
});

app.get(/^\/(v\d+)\/?$/i, (_req, res) => {
  return res.redirect(302, "/en");
});

app.get(/^\/(en|tr|al)(?:\/.*)?$/i, (_req, res) => {
  return res.sendFile(indexFile);
});

app.get(/^\/([a-z]{2,3})(?:\/.*)?$/i, (req, res, next) => {
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
