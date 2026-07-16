import { PDFParse } from "pdf-parse";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth") as {
  extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
};

export const legacyDocumentTextExtractor = {
  async extract({ buffer, mimetype }: { buffer: Buffer; mimetype: string }) {
    if (mimetype === "application/pdf") {
      const parser = new PDFParse({ data: buffer });
      try {
        const parsed = await parser.getText();
        return parsed.text ?? "";
      } finally {
        await parser.destroy();
      }
    }
    if (
      mimetype === "application/msword" ||
      mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value ?? "";
    }
    return buffer.toString("utf-8");
  },
};
