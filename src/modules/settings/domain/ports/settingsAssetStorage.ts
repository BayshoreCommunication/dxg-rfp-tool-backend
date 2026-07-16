export interface SettingsAssetStorage {
  upload(input: { localPath: string; objectKey: string }): Promise<string>;
}
