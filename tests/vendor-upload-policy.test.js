const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const multer = require("multer");
const { vendorDocumentFilter } = require("../middleware/upload");
const { FLAT_MULTIPART_FIELD_LIMITS } = require("../middleware/multipartCompatibility");
const {
  vendorUploadMalwareScan,
  vendorUploadScanRequired,
} = require("../src/modules/vendorResponses/infrastructure/security/vendorUploadMalwareScan");

const runFileFilter = (file) =>
  new Promise((resolve, reject) => {
    vendorDocumentFilter({}, file, (error, accepted) => {
      if (error) reject(error);
      else resolve(accepted);
    });
  });

test("vendor response attachments accept arbitrary file formats", async () => {
  const files = [
    { originalname: "brand.webp", mimetype: "image/webp" },
    { originalname: "source.zip", mimetype: "application/zip" },
    { originalname: "model.blend", mimetype: "application/octet-stream" },
    { originalname: "no-extension", mimetype: "" },
  ];

  for (const file of files) {
    assert.equal(await runFileFilter(file), true, file.originalname);
  }
});

test("multipart filename decoding keeps legacy escaped upload metadata", async () => {
  const file = {
    originalname: 'quote"line\r\nbreak.pdf',
    mimetype: "application/pdf",
  };

  assert.equal(await runFileFilter(file), true);
  assert.equal(file.originalname, "quote%22line%0D%0Abreak.pdf");
});

test("WHATWG multipart uploads retain literal escaped filename text", async (t) => {
  const app = express();
  let observedName;
  let uploadErrorCode;
  app.post(
    "/",
    multer({
      storage: multer.memoryStorage(),
      fileFilter: vendorDocumentFilter,
      limits: FLAT_MULTIPART_FIELD_LIMITS,
    }).single("file"),
    (req, res) => {
      observedName = req.file.originalname;
      res.status(204).end();
    },
  );
  app.use((error, _req, res, _next) => {
    uploadErrorCode = error.code;
    res.status(400).json({ code: error.code });
  });

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, "object");
  const form = new FormData();
  form.append(
    "file",
    new Blob(["test"], { type: "application/pdf" }),
    "quote%22line%0Abreak.pdf",
  );
  const response = await fetch(`http://127.0.0.1:${address.port}`, {
    method: "POST",
    body: form,
  });

  assert.equal(response.status, 204);
  assert.equal(observedName, "quote%22line%0Abreak.pdf");

  const nestedForm = new FormData();
  nestedForm.append("payload[1000000000]", "blocked");
  const nestedResponse = await fetch(`http://127.0.0.1:${address.port}`, {
    method: "POST",
    body: nestedForm,
  });
  assert.equal(nestedResponse.status, 400);
  assert.equal(uploadErrorCode, "LIMIT_FIELD_NESTING");
});

test("missing malware scanner blocks production but not local development", async () => {
  const original = {
    nodeEnv: process.env.NODE_ENV,
    scanRequired: process.env.VENDOR_UPLOAD_SCAN_REQUIRED,
    clamAvHost: process.env.CLAMAV_HOST,
  };

  try {
    delete process.env.VENDOR_UPLOAD_SCAN_REQUIRED;
    delete process.env.CLAMAV_HOST;

    process.env.NODE_ENV = "development";
    assert.equal(vendorUploadScanRequired(), false);
    assert.equal(await vendorUploadMalwareScan("unused-local-path"), "skipped");

    process.env.NODE_ENV = "production";
    assert.equal(vendorUploadScanRequired(), true);
    assert.equal(await vendorUploadMalwareScan("unused-local-path"), "unavailable");

    process.env.VENDOR_UPLOAD_SCAN_REQUIRED = "false";
    assert.equal(vendorUploadScanRequired(), false);

    process.env.NODE_ENV = "development";
    process.env.VENDOR_UPLOAD_SCAN_REQUIRED = "true";
    assert.equal(vendorUploadScanRequired(), true);
  } finally {
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("NODE_ENV", original.nodeEnv);
    restore("VENDOR_UPLOAD_SCAN_REQUIRED", original.scanRequired);
    restore("CLAMAV_HOST", original.clamAvHost);
  }
});
