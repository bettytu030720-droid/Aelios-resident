// The file reader anchors each note to the offsets of the selected text, including text across inline Markdown marks.
function readingNotesPage() {
  return {
    async loadReadingNotes(view, bytes, file) {
      if (!globalThis.crypto?.subtle || !view.text.trim() || bytes.length > 1024 * 1024) return;
      view.reading = { file: file, revision: '', notes: [], selection: null, busy: false, savedOpen: false, loading: true, error: '' };
      var reading = view.reading;
      try {
        var hash = await crypto.subtle.digest('SHA-256', bytes);
        if (this.fileView !== view) return;
        reading.revision = Array.from(new Uint8Array(hash), function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
        var params = new URLSearchParams(Object.assign({ revision: reading.revision }, file));
        var result = await this.api('/web/reading-notes?' + params);
        if (this.fileView !== view) return;
        if (result.notes === null) view.reading = null;
        else reading.notes = result.notes;
      } catch (error) {
        if (this.fileView === view) reading.error = error.message;
      } finally {
        reading.loading = false;
      }
    },

    trackReadingSelection(reader, page) {
      var reading = this.fileView.reading;
      if (!reading || this.view !== page || !this.authed) return;
      var selected = window.getSelection();
      if (!selected || selected.isCollapsed || !selected.rangeCount) return;
      var range = selected.getRangeAt(0);
      var root = reader.querySelector(this.fileView.kind === 'markdown' ? '.file-md' : '.file-text');
      if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
      var prefix = root.ownerDocument.createRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(range.startContainer, range.startOffset);
      var start = prefix.toString().length;
      var quote = range.toString();
      start += quote.length - quote.trimStart().length;
      quote = quote.trim();
      reading.selection = quote ? { start: start, end: start + quote.length, quote: quote } : null;
      reading.error = quote.length > 1200 ? '请选 1200 字以内的一段' : '';
    },

    async saveReadingNote() {
      var view = this.fileView;
      var reading = view.reading;
      var selection = reading && reading.selection;
      if (!selection || selection.quote.length > 1200 || reading.busy || reading.loading || !reading.revision) return;
      reading.busy = true;
      reading.error = '';
      try {
        var result = await this.api('/web/reading-notes', { method: 'POST', body: {
          document: reading.file, revision: reading.revision, selection: selection
        } });
        if (this.fileView !== view) return;
        var note = result.note;
        reading.notes = reading.notes.filter(function (saved) { return saved.start !== note.start || saved.end !== note.end; })
          .concat(note).sort(function (a, b) { return a.start - b.start || a.end - b.end; });
        if (reading.selection === selection) reading.selection = null;
        reading.savedOpen = true;
      } catch (error) {
        if (this.fileView === view) reading.error = error.message;
      } finally {
        reading.busy = false;
      }
    },

    showReadingPassage(reader, note) {
      var root = reader.querySelector(this.fileView.kind === 'markdown' ? '.file-md' : '.file-text');
      if (!root || root.textContent.slice(note.start, note.end) !== note.quote) return;
      var doc = root.ownerDocument;
      var nodes = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      var range = doc.createRange();
      var offset = 0;
      var started = false;
      var node;
      while ((node = nodes.nextNode())) {
        var end = offset + node.length;
        if (!started && note.start < end) {
          range.setStart(node, note.start - offset);
          started = true;
        }
        if (started && note.end <= end) {
          range.setEnd(node, note.end - offset);
          var selected = window.getSelection();
          if (selected) {
            selected.removeAllRanges();
            selected.addRange(range);
          }
          if (this.fileView.kind === 'text' && root.scrollHeight > root.clientHeight) {
            var box = root.getBoundingClientRect();
            var line = range.getClientRects()[0] || range.getBoundingClientRect();
            root.scrollTop += line.top + line.height / 2 - box.top - root.clientTop - root.clientHeight / 2;
          }
          range.startContainer.parentElement.scrollIntoView({ block: 'center', inline: 'nearest' });
          return;
        }
        offset = end;
      }
    }
  };
}
