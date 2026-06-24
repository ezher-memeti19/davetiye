const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
require("dotenv").config();

const app = express();

const port = Number(process.env.PORT || 3000);
const maxFileSizeBytes = Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES || 10 * 1024 * 1024);
const maxFileCount = Number(process.env.MAX_UPLOAD_FILE_COUNT || 10);
const dropboxRoot = process.env.DROPBOX_UPLOAD_ROOT || "/Wedding-Guest-Uploads";

const requiredEnv = [
  "DROPBOX_CLIENT_ID",
  "DROPBOX_CLIENT_SECRET",
  "DROPBOX_REFRESH_TOKEN"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxFileSizeBytes,
    files: maxFileCount
  }
});

let cachedAccessToken = "";
let cachedAccessTokenExpiresAt = 0;

function sanitizeSegment(value, fallback) {
  const clean = String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 64);
  return clean || fallback;
}

function buildSubmissionId(guestName) {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = crypto.randomBytes(3).toString("hex");
  const namePart = sanitizeSegment(guestName, "guest");
  return `${ts}-${namePart}-${rand}`;
}

async function getDropboxAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessTokenExpiresAt - now > 60_000) {
    return cachedAccessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
    client_id: process.env.DROPBOX_CLIENT_ID,
    client_secret: process.env.DROPBOX_CLIENT_SECRET
  });

  const tokenRes = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Dropbox OAuth token refresh failed: ${tokenRes.status} ${errText}`);
  }

  const tokenJson = await tokenRes.json();
  cachedAccessToken = tokenJson.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Number(tokenJson.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

async function uploadFileToDropbox(accessToken, filePath, buffer) {
  const uploadRes = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path: filePath,
        mode: "add",
        autorename: true,
        mute: false,
        strict_conflict: false
      })
    },
    body: buffer
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Dropbox upload failed: ${uploadRes.status} ${errText}`);
  }
}

app.use(express.static(path.join(__dirname)));

app.post("/api/photos/upload", upload.array("photos", maxFileCount), async (req, res) => {
  try {
    const files = req.files || [];
    const guestName = (req.body?.guestName || "").trim();
    const message = (req.body?.message || "").trim();

    if (files.length < 1) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    for (const file of files) {
      if (!file.mimetype || !file.mimetype.startsWith("image/")) {
        return res.status(400).json({ error: "Only image files are allowed." });
      }
    }

    const submissionId = buildSubmissionId(guestName);
    const submissionFolder = `${dropboxRoot}/${submissionId}`;
    const accessToken = await getDropboxAccessToken();

    const metadata = {
      submissionId,
      guestName: guestName || null,
      message: message || null,
      uploadedAt: new Date().toISOString(),
      totalFiles: files.length
    };

    await uploadFileToDropbox(
      accessToken,
      `${submissionFolder}/submission.json`,
      Buffer.from(JSON.stringify(metadata, null, 2), "utf8")
    );

    for (const [index, file] of files.entries()) {
      const original = sanitizeSegment(file.originalname, `photo_${index + 1}.jpg`);
      const fileName = `${String(index + 1).padStart(2, "0")}-${original}`;
      await uploadFileToDropbox(accessToken, `${submissionFolder}/${fileName}`, file.buffer);
    }

    return res.status(200).json({
      ok: true,
      submissionId
    });
  } catch (error) {
    console.error("Upload route error:", error);
    return res.status(500).json({ error: "Upload failed." });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "One or more files exceed the size limit." });
    }
    if (error.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ error: "Too many files uploaded." });
    }
    return res.status(400).json({ error: "Invalid upload request." });
  }
  console.error("Unhandled server error:", error);
  return res.status(500).json({ error: "Server error." });
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
