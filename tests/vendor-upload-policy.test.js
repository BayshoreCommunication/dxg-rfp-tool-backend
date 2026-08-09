const assert = require("node:assert/strict");
const test = require("node:test");
const { vendorDocumentFilter } = require("../middleware/upload");
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
