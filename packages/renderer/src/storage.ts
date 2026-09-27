import { StorageAdapter } from './index';
import { config } from '@slideify/config';

export class LocalStorageAdapter implements StorageAdapter {
  private basePath: string;

  constructor(basePath: string = './outputs') {
    this.basePath = basePath;
  }

  async upload(key: string, buffer: Buffer, contentType: string): Promise<string> {
    const fs = require('fs').promises;
    const path = require('path');
    const dir = path.join(this.basePath, key.substring(0, 2));
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, key);
    await fs.writeFile(filePath, buffer);
    return `${config.storage.publicUrl || 'http://localhost:3000'}/storage/${key}`;
  }

  async getSignedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    return `${config.storage.publicUrl || 'http://localhost:3000'}/storage/${key}`;
  }

  async delete(key: string): Promise<void> {
    const fs = require('fs').promises;
    const path = require('path');
    const filePath = path.join(this.basePath, key);
    try { await fs.unlink(filePath); } catch { /* ignore */ }
  }
}

export class StorageAdapterFactory {
  static create(): StorageAdapter {
    if (!config.storage.endpoint) {
      return new LocalStorageAdapter();
    }
    // Future: S3, GCS, etc.
    throw new Error('Cloud storage not yet implemented');
  }
}