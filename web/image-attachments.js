export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export class ImageAttachmentDraft {
  constructor({ upload, createObjectURL, revokeObjectURL, onChange = () => {} }) {
    this.upload = upload;
    this.createObjectURL = createObjectURL;
    this.revokeObjectURL = revokeObjectURL;
    this.onChange = onChange;
    this.items = [];
    this.nextKey = 1;
    this.queue = Promise.resolve();
  }

  async addFiles(files) {
    const errors = [];
    const tasks = [];
    let remaining = Math.max(0, MAX_IMAGES - this.availableCount());

    for (const file of Array.from(files ?? [])) {
      if (!IMAGE_MEDIA_TYPES.has(file.type)) {
        errors.push(`${file.name}: supported image types are PNG, JPEG, WebP, and GIF.`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        errors.push(`${file.name}: images must be 5 MiB or smaller.`);
        continue;
      }
      if (remaining === 0) {
        errors.push(`${file.name}: a message can include at most four images.`);
        continue;
      }
      remaining -= 1;
      const item = {
        key: `image-${this.nextKey++}`,
        file,
        preview_url: this.createObjectURL(file),
        status: 'queued',
        attachment: null,
        error: null,
      };
      this.items.push(item);
      this.onChange(this);
      tasks.push(this.#enqueue(item));
    }

    await Promise.all(tasks);
    return { added: tasks.length, errors };
  }

  #enqueue(item) {
    const task = this.queue.then(() => this.#upload(item));
    this.queue = task.catch(() => {});
    return task;
  }

  async #upload(item) {
    if (!this.items.includes(item)) return;
    item.status = 'uploading';
    item.error = null;
    this.onChange(this);
    try {
      const attachment = await this.upload(item.file);
      if (!this.items.includes(item)) return;
      item.attachment = attachment;
      item.status = 'uploaded';
    } catch (error) {
      if (!this.items.includes(item)) return;
      item.status = 'error';
      item.error = error?.message || String(error);
    }
    this.onChange(this);
  }

  retry(key) {
    const item = this.items.find((candidate) => candidate.key === key);
    if (!item || item.status !== 'error') return Promise.resolve(false);
    item.status = 'queued';
    item.error = null;
    this.onChange(this);
    return this.#enqueue(item).then(() => true);
  }

  remove(key) {
    const index = this.items.findIndex((item) => item.key === key);
    if (index === -1) return false;
    const [item] = this.items.splice(index, 1);
    this.revokeObjectURL(item.preview_url);
    this.onChange(this);
    return true;
  }

  hasPending() {
    return this.items.some((item) => item.status === 'queued' || item.status === 'uploading');
  }

  attachmentIds() {
    return this.items
      .filter((item) => item.status === 'uploaded' && item.attachment?.id)
      .slice(0, MAX_IMAGES)
      .map((item) => item.attachment.id);
  }

  readyCount() {
    return this.items.filter((item) => item.status === 'uploaded' && item.attachment?.id).length;
  }

  availableCount() {
    return this.items.filter((item) => item.status !== 'submitting').length;
  }

  claim(ids) {
    const requested = new Set(ids ?? []);
    const claimed = [];
    for (const item of this.items) {
      if (item.status !== 'uploaded' || !requested.has(item.attachment?.id)) continue;
      item.status = 'submitting';
      claimed.push(item.attachment.id);
    }
    this.onChange(this);
    return claimed;
  }

  restoreClaim(ids) {
    const failed = new Set(ids ?? []);
    for (const item of this.items) {
      if (item.status === 'submitting' && failed.has(item.attachment?.id)) item.status = 'uploaded';
    }
    this.onChange(this);
  }

  clearSent(ids) {
    const sent = new Set(ids ?? []);
    for (const item of [...this.items]) {
      if (item.attachment?.id && sent.has(item.attachment.id)) this.remove(item.key);
    }
  }
}

export function captureComposerSubmission({ selectedKind, selectedId, mode, senderId = '', priorityReason = null, text = '', attachmentIds = [] }) {
  return {
    selectedKind,
    selectedId,
    mode,
    senderId,
    priorityReason,
    text,
    attachmentIds: [...attachmentIds],
  };
}

export function requestForSubmission(submission) {
  if (submission.selectedKind === 'room') {
    return {
      route: '/api/rooms/say',
      body: { room_id: submission.selectedId, text: submission.text, attachments: submission.attachmentIds },
    };
  }
  if (submission.mode === 'peer') {
    return {
      route: '/api/send',
      body: {
        sender_id: submission.senderId,
        target_id: submission.selectedId,
        text: submission.text,
        priority_reason: submission.priorityReason || null,
        attachments: submission.attachmentIds,
      },
    };
  }
  return {
    route: '/api/ask',
    body: { agent_id: submission.selectedId, text: submission.text, attachments: submission.attachmentIds },
  };
}

export function restoreFailedText(submittedText, currentText) {
  if (!submittedText) return currentText;
  if (!currentText.trim()) return submittedText;
  return `${submittedText}\n\n${currentText}`;
}

export function attachmentQueueNote(readyCount) {
  if (readyCount <= MAX_IMAGES) return '';
  return `The next 4 images will be sent. ${readyCount - MAX_IMAGES} will remain for the following message.`;
}

export function renderAttachmentGallery(attachments, documentRef = document) {
  const gallery = documentRef.createElement('div');
  gallery.className = 'message-attachments';
  for (const attachment of attachments ?? []) {
    if (!attachment?.url) continue;
    const link = documentRef.createElement('a');
    link.href = attachment.url;
    link.target = '_blank';
    link.rel = 'noopener';
    const image = documentRef.createElement('img');
    image.src = attachment.url;
    image.alt = attachment.name || 'Attached image';
    image.loading = 'lazy';
    link.append(image);
    gallery.append(link);
  }
  return gallery;
}
