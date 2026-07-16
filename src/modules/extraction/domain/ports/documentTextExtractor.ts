export interface DocumentTextExtractor {
  extract(input: { buffer: Buffer; mimetype: string }): Promise<string>;
}
