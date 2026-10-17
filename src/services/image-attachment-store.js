import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HostError } from '../core/util.js';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_BASE64 = Math.ceil(MAX_BYTES / 3) * 4;
const ID = /^img_[a-f0-9]{32}$/;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const invalid = (message) => new HostError('invalid_attachment', message);

function validName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 255
    && !/[\x00-\x1f\x7f/\\]/.test(name);
}

// Validate file signatures/container boundaries, without trusting MIME or names.
// Full image decoding remains the consumer's responsibility.
function matchesType(buffer, type) {
  const text = (start, end) => buffer.toString('ascii', start, end);
  if (type === 'image/png') {
    return buffer.length >= 45 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      && buffer.readUInt32BE(8) === 13 && text(12, 16) === 'IHDR'
      && buffer.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'));
  }
  if (type === 'image/jpeg') {
    return buffer.length >= 20 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      && buffer.indexOf(Buffer.from('ffda', 'hex'), 2) !== -1
      && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  }
  if (type === 'image/gif') {
    return buffer.length >= 14 && ['GIF87a', 'GIF89a'].includes(text(0, 6))
      && buffer.readUInt16LE(6) > 0 && buffer.readUInt16LE(8) > 0 && buffer.at(-1) === 0x3b;
  }
  return type === 'image/webp' && buffer.length > 20 && text(0, 4) === 'RIFF'
    && buffer.readUInt32LE(4) === buffer.length - 8 && text(8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(text(12, 16))
    && buffer.readUInt32LE(16) > 0 && buffer.readUInt32LE(16) <= buffer.length - 20;
}

function readFile(file, limit) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw invalid('Invalid stored attachment file');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Host-owned image storage. The caller supplies a directory outside public assets/workspaces. */
export class ImageAttachmentStore {
  constructor({ dir }) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(this.dir).isDirectory()) throw invalid('Attachment storage must be a directory');
    fs.chmodSync(this.dir, 0o700);
  }

  save(input) {
    if (!input || typeof input !== 'object' || !validName(input.name) || !TYPES.has(input.media_type)
      || typeof input.data !== 'string') throw invalid('Provide an image name, supported MIME type and raw base64 data');
    const { name, media_type, data } = input;
    if (data.length > MAX_BASE64) throw new HostError('attachment_too_large', 'Each image must be at most 5 MiB');
    if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw invalid('Image data must be canonical raw base64');
    }
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > MAX_BYTES) throw new HostError('attachment_too_large', 'Each image must be at most 5 MiB');
    if (buffer.toString('base64') !== data || !matchesType(buffer, media_type)) {
      throw invalid('Image bytes do not match a supported image format and MIME type');
    }
    const id = `img_${randomBytes(16).toString('hex')}`;
    const attachment = { id, name, media_type, size: buffer.length, url: `/api/attachments/${id}` };
    const staging = fs.mkdtempSync(path.join(this.dir, '.upload-'));
    try {
      fs.chmodSync(staging, 0o700);
      fs.writeFileSync(path.join(staging, 'image.bin'), buffer, { flag: 'wx', mode: 0o600, flush: true });
      fs.writeFileSync(path.join(staging, 'metadata.json'), JSON.stringify(attachment), { flag: 'wx', mode: 0o600, flush: true });
      fs.renameSync(staging, path.join(this.dir, id));
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new HostError('attachment_store_error', 'Could not persist image attachment', { cause: error.code });
    }
    return attachment;
  }

  resolve(ids = []) {
    if (!Array.isArray(ids) || ids.length > 4 || ids.some((id) => typeof id !== 'string' || !ID.test(id))) {
      throw invalid('Provide at most four valid image attachment IDs');
    }
    return ids.map((id) => this.read(id).attachment);
  }

  read(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw invalid('Invalid image attachment ID');
    const dir = path.join(this.dir, id);
    try {
      if (!fs.lstatSync(dir).isDirectory()) throw invalid('Invalid stored attachment directory');
      const stored = JSON.parse(readFile(path.join(dir, 'metadata.json'), 4096).toString('utf8'));
      if (!stored || stored.id !== id || !validName(stored.name) || !TYPES.has(stored.media_type)
        || !Number.isInteger(stored.size) || stored.size < 1 || stored.size > MAX_BYTES
        || stored.url !== `/api/attachments/${id}`) throw invalid('Invalid stored attachment metadata');
      const buffer = readFile(path.join(dir, 'image.bin'), MAX_BYTES);
      if (buffer.length !== stored.size || !matchesType(buffer, stored.media_type)) throw invalid('Invalid stored image bytes');
      const attachment = { id, name: stored.name, media_type: stored.media_type, size: stored.size, url: stored.url };
      return { attachment, buffer };
    } catch (error) {
      if (error instanceof HostError) throw error;
      if (error.code === 'ENOENT') throw new HostError('attachment_not_found', 'Image attachment was not found');
      throw invalid('Image attachment could not be read');
    }
  }

  image(id) {
    const { attachment, buffer } = this.read(id);
    return { media_type: attachment.media_type, data: buffer.toString('base64') };
  }
}
