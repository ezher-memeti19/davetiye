const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const vm = require("vm");
const express = require("express");
const multer = require("multer");
require("dotenv").config();

const app = express();
app.set("trust proxy", true);

const port = Number(process.env.PORT || 3000);
const maxFileSizeBytes = Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES || 10 * 1024 * 1024);
const maxFileCount = Number(process.env.MAX_UPLOAD_FILE_COUNT || 10);
const dropboxRoot = process.env.DROPBOX_UPLOAD_ROOT || "/Wedding-Guest-Uploads";
const supportedLanguages = ["tr", "al", "en"];
const defaultLanguage = "en";
const languageStorageKey = "wedding_language";
const legacyLanguageStorageKey = "wedding_lang";
const indexPath = path.join(__dirname, "index.html");
const scriptPath = path.join(__dirname, "script.js");

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

let cachedIndexHtml = "";
let cachedTranslations = null;
let cachedAccessToken = "";
let cachedAccessTokenExpiresAt = 0;

function getIndexHtml() {
  if (!cachedIndexHtml || process.env.NODE_ENV !== "production") {
    cachedIndexHtml = fs.readFileSync(indexPath, "utf8");
  }
  return cachedIndexHtml;
}

function extractObjectLiteral(source, variableName) {
  const assignmentIndex = source.indexOf(`const ${variableName} =`);
  if (assignmentIndex < 0) return "";

  const objectStart = source.indexOf("{", assignmentIndex);
  if (objectStart < 0) return "";

  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index];
    const nextChar = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === "*" && nextChar === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === "/" && nextChar === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(objectStart, index + 1);
    }
  }

  return "";
}

function getTranslations() {
  if (cachedTranslations && process.env.NODE_ENV === "production") return cachedTranslations;

  const scriptSource = fs.readFileSync(scriptPath, "utf8");
  const translationsSource = extractObjectLiteral(scriptSource, "translations");
  const sandbox = {};

  vm.runInNewContext(`translations = ${translationsSource};`, sandbox, { timeout: 1000 });
  cachedTranslations = sandbox.translations || {};
  return cachedTranslations;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getSiteUrl(req) {
  const configuredSiteUrl = (process.env.SITE_URL || "").replace(/\/+$/, "");
  if (configuredSiteUrl) return configuredSiteUrl;
  return `${req.protocol}://${req.get("host")}`;
}

function getLocalizedMetadata(lang, req) {
  const translations = getTranslations();
  const dict = translations[lang] || translations[defaultLanguage] || {};
  const title = `Eda & Ezher | ${dict.hero_eyebrow || "Wedding Invitation"}`;
  const description =
    dict.meta_description || "Join us for the wedding celebration of Eda and Ezher on August 3, 2026.";
  const baseUrl = getSiteUrl(req);
  const canonicalUrl = `${baseUrl}/${lang}`;

  return {
    title,
    description,
    canonicalUrl,
    alternates: supportedLanguages.map((language) => ({
      lang: language,
      url: `${baseUrl}/${language}`
    }))
  };
}

function renderLocalizedPage(lang, req) {
  const metadata = getLocalizedMetadata(lang, req);
  const alternateLinks = metadata.alternates
    .map(
      (alternate) =>
        `<link rel="alternate" hreflang="${alternate.lang}" href="${escapeHtml(alternate.url)}" />`
    )
    .join("\n  ");

  const seoTags = [
    `<link rel="canonical" href="${escapeHtml(metadata.canonicalUrl)}" />`,
    alternateLinks,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:locale" content="${lang}" />`,
    `<meta property="og:url" content="${escapeHtml(metadata.canonicalUrl)}" />`,
    `<meta property="og:title" content="${escapeHtml(metadata.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(metadata.description)}" />`
  ].join("\n  ");

  return getIndexHtml()
    .replace(/<html lang="[^"]*"/, `<html lang="${lang}"`)
    .replace(/<title>.*?<\/title>/s, `<title>${escapeHtml(metadata.title)}</title>\n  ${seoTags}`)
    .replace(
      /<meta name="description" content="[^"]*"([^>]*)>/,
      `<meta name="description" content="${escapeHtml(metadata.description)}"$1>`
    );
}

function renderLanguageRedirectPage() {
  return `<!DOCTYPE html>
<html lang="${defaultLanguage}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  <title>Redirecting...</title>
  <script>
    (function () {
      var supportedLanguages = ${JSON.stringify(supportedLanguages)};
      var defaultLanguage = ${JSON.stringify(defaultLanguage)};
      var selectedLanguage = null;

      try {
        var storedLanguage =
          window.localStorage.getItem(${JSON.stringify(languageStorageKey)}) ||
          window.localStorage.getItem(${JSON.stringify(legacyLanguageStorageKey)});
        if (supportedLanguages.indexOf(storedLanguage) >= 0) selectedLanguage = storedLanguage;
      } catch (error) {}

      if (!selectedLanguage) {
        var browserLanguage =
          ((window.navigator.languages && window.navigator.languages[0]) || window.navigator.language || "")
            .toLowerCase();

        if (browserLanguage.indexOf("tr") === 0) selectedLanguage = "tr";
        else if (browserLanguage.indexOf("al") === 0 || browserLanguage.indexOf("sq") === 0) selectedLanguage = "al";
        else selectedLanguage = defaultLanguage;
      }

      try {
        window.localStorage.setItem(${JSON.stringify(languageStorageKey)}, selectedLanguage);
      } catch (error) {}

      window.location.replace("/" + selectedLanguage + window.location.hash);
    })();
  </script>
</head>
<body>
  <noscript><a href="/${defaultLanguage}">Continue to invitation</a></noscript>
</body>
</html>`;
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

app.get("/", (_req, res) => {
  res.type("html").send(renderLanguageRedirectPage());
});

app.get("/:lang", (req, res, next) => {
  const { lang } = req.params;
  if (lang.includes(".") || lang === "api") return next();
  if (!supportedLanguages.includes(lang)) return res.redirect(302, `/${defaultLanguage}`);
  return res.type("html").send(renderLocalizedPage(lang, req));
});

app.use(express.static(path.join(__dirname), { index: false }));

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
