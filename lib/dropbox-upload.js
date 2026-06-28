const crypto = require("crypto");

const maxFileSizeBytes = Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES || 10 * 1024 * 1024);
const maxFileCount = Number(process.env.MAX_UPLOAD_FILE_COUNT || 10);
const dropboxRoot = process.env.DROPBOX_UPLOAD_ROOT || "/Wedding-Guest-Uploads";

let cachedAccessToken = "";
let cachedAccessTokenExpiresAt = 0;

function isDropboxConfigured() {
  return Boolean(
    process.env.DROPBOX_CLIENT_ID && process.env.DROPBOX_CLIENT_SECRET && process.env.DROPBOX_REFRESH_TOKEN
  );
}

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

function validateFiles(files) {
  if (!Array.isArray(files) || files.length < 1) {
    return "No files uploaded.";
  }

  for (const file of files) {
    const mimeType = file?.mimetype || "";
    if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) {
      return "Only image or video files are allowed.";
    }
  }

  return "";
}

async function uploadSubmission({ files, guestName = "", message = "" }) {
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
    const original = sanitizeSegment(file.originalname, `upload_${index + 1}`);
    const fileName = `${String(index + 1).padStart(2, "0")}-${original}`;
    await uploadFileToDropbox(accessToken, `${submissionFolder}/${fileName}`, file.buffer);
  }

  return { submissionId };
}

module.exports = {
  buildSubmissionId,
  dropboxRoot,
  getDropboxAccessToken,
  isDropboxConfigured,
  maxFileCount,
  maxFileSizeBytes,
  sanitizeSegment,
  uploadSubmission,
  validateFiles
};
