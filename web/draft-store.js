/** Drafts are local to this browser origin and conversation, never sent automatically. */
export function draftStore(storage, prefix = 'better-bots.draft.v1:') {
  return {
    read(key) {
      try {
        const value = JSON.parse(storage.getItem(prefix + key) || 'null');
        return value && typeof value.text === 'string' ? value : { text: '', attachments: false };
      } catch { return { text: '', attachments: false }; }
    },
    save(key, text, attachments = false) {
      try {
        if (!text && !attachments) storage.removeItem(prefix + key);
        else storage.setItem(prefix + key, JSON.stringify({ text, attachments }));
        return true;
      } catch { return false; }
    },
  };
}
