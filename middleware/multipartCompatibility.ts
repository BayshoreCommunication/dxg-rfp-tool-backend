// Multer 2.3 decodes the three filename escapes emitted by WHATWG FormData.
// Existing upload records intentionally retain those escaped characters, so
// restore that representation before storage keys or user-visible metadata are
// derived from originalname.
export const preserveLegacyMultipartFilename = (file: { originalname: string }): void => {
  file.originalname = file.originalname.replace(/["\r\n]/g, (character) => {
    if (character === "\"") return "%22";
    if (character === "\r") return "%0D";
    return "%0A";
  });
};

// Every multipart field used by this application is flat. Multer 2.3 exposes
// these opt-in limits so hostile bracket paths cannot create deeply nested or
// extremely sparse request bodies before route validation runs.
export const FLAT_MULTIPART_FIELD_LIMITS = {
  fieldNestingDepth: 0,
  fieldArrayIndexLimit: 0,
} as const;
