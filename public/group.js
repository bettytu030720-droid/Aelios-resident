// Group chats (src/group.ts): she makes groups of some of her residents and talks with them there. app.js mixes this
// into the page's state. The groups live in the first resident, so they are the same from whichever resident's page.
function groupPage() {
  var GROUP_MS = 3000;
  var groupTimer = 0;
  var groupPicLoading = {};
  // A sticker in a group is some resident's, shown from that resident's address.
  var STICKER_URL = /^(\/r\/[a-z][a-z0-9-]{0,23})?\/stickers\/[0-9a-f]{24}$/;
  // `seen` is the latest line the server has handed the page: what to ask after. A line of hers the page put in
  // itself does not move it, so a reply that reached the server just before it is still fetched.
  function freshGroup(id) {
    return { id: id || '', name: '', loaded: false, lines: [], seen: 0, more: false, members: [], config: null, speaking: '', waiting: [], running: false, draft: '', busy: false, error: '' };
  }
  // Lines put together once each, in the order they were said.
  function merged(lines, more) {
    var have = {};
    lines.forEach(function (line) { have[line.seq] = true; });
    var fresh = more.filter(function (line) { return !have[line.seq]; });
    return fresh.length ? lines.concat(fresh).sort(function (a, b) { return a.seq - b.seq; }) : lines;
  }
  function lastSeq(lines, seq) {
    return lines.reduce(function (max, line) { return Math.max(max, line.seq); }, seq);
  }
  return {
    groups: [],
    group: freshGroup(),
    // The sheet that makes a group (id '') or changes one.
    groupEdit: null,
    // A group needs at least two residents.
    groupOn() {
      return !this.miniApp && this.residents.list.length > 1;
    },
    async loadGroups() {
      if (!this.groupOn()) { this.groups = []; return; }
      var data = await this.api('/web/groups');
      this.groups = data.groups || [];
    },
    openGroup(id) {
      this.residents.open = false;
      this.view = 'group';
      this.group = freshGroup(id);
      // The box below is the chat's: pictures and the sticker panel start empty here.
      this.pics = [];
      this.panel = '';
      this.loadGroup();
    },
    groupPath(path, query) {
      return '/web/' + path + '?g=' + encodeURIComponent(this.group.id) + (query || '');
    },
    async loadGroup(older) {
      var group = this.group;
      try {
        var first = group.lines[0];
        var data = await this.api(this.groupPath('group', older && first ? '&before=' + first.seq : ''));
        if (group !== this.group) return;
        group.lines = older ? merged(group.lines, data.lines) : data.lines;
        if (!older) group.seen = lastSeq(data.lines, 0);
        group.more = data.more;
        this.takeGroup(data);
        group.loaded = true;
        if (!older) this.groupToEnd();
      } catch (error) {
        if (!error.moved) group.error = error.message;
      }
      if (!older) this.pollGroup();
    },
    takeGroup(data) {
      var group = this.group;
      if (data.group) {
        group.name = data.group.name;
        group.members = data.group.members;
        group.config = data.group;
      }
      group.speaking = data.speaking || '';
      group.waiting = data.waiting || [];
      group.running = Boolean(data.running);
    },
    // New lines every few seconds while the group is open and in sight.
    pollGroup() {
      var self = this;
      clearTimeout(groupTimer);
      groupTimer = setTimeout(async function () {
        if (self.view !== 'group' || !self.authed) return;
        if (!document.hidden) {
          try { await self.groupNews(); } catch (error) { /* tried again on the next tick */ }
        }
        self.pollGroup();
      }, GROUP_MS);
    },
    // The lines the server has after the last one it handed the page.
    async groupNews() {
      var group = this.group;
      var data = await this.api(this.groupPath('group', '&after=' + group.seen));
      if (this.view !== 'group' || group !== this.group) return;
      var count = group.lines.length;
      group.lines = merged(group.lines, data.lines || []);
      group.seen = lastSeq(data.lines || [], group.seen);
      this.takeGroup(data);
      if (group.lines.length > count) this.groupToEnd();
    },
    groupToEnd() {
      var self = this;
      this.$nextTick(function () { var el = self.$refs && self.$refs.groupStream; if (el) el.scrollTop = el.scrollHeight; });
    },
    canSayInGroup() {
      return Boolean(this.group.draft.trim() || this.pics.length) && !this.group.busy;
    },
    // Words and the pictures picked below the box (the chat's own), or one sticker on its own.
    async sayInGroup(sticker) {
      var group = this.group;
      var body = sticker ? { sticker: { from: this.resident, key: sticker.key } } : { text: group.draft.trim() };
      if (!sticker && this.pics.length) body.pictures = this.pics.map(function (pic) { return { data: pic.data }; });
      if (group.busy || !(sticker || body.text || body.pictures)) return;
      group.busy = true;
      group.error = '';
      this.panel = '';
      try {
        var data = await this.api(this.groupPath('group/say'), { method: 'POST', body: body });
        if (!sticker) { group.draft = ''; this.pics = []; }
        group.lines = merged(group.lines, [data.line]);
        group.running = true;
        this.groupToEnd();
      } catch (error) {
        if (!error.moved) group.error = error.message;
      } finally {
        group.busy = false;
      }
    },
    // A resident's words in bubbles as in the chat (a blank line starts a new one); hers in one.
    groupBubbles(line) {
      if (!line.author) return String(line.text || '').trim() ? [{ text: line.text, first: true, last: true }] : [];
      return this.bubblesOf({ role: 'assistant', text: line.text });
    },
    groupStickers(line) {
      return (line.stickers || []).filter(function (sticker) { return STICKER_URL.test(String(sticker.url || '')); });
    },
    groupPics(line) {
      var list = [];
      for (var n = 0; n < Math.min(line.pictures || 0, 4); n++) list.push(n);
      return list;
    },
    // A picture of hers in a group, read with the web key and shown from memory, like one in the chat. Asked once at a
    // time: once it is in, picUrls holds it, and when switching residents empties that it is asked again.
    groupPicUrl(line, n) {
      var key = 'g:' + this.group.id + ':' + line.seq + ':' + n;
      var url = this.picUrls[key];
      if (url !== undefined || groupPicLoading[key]) return url || '';
      groupPicLoading[key] = true;
      var self = this;
      this.api(this.groupPath('group/picture', '&seq=' + line.seq + '&n=' + n), { blob: true }).then(function (blob) {
        var next = Object.assign({}, self.picUrls);
        next[key] = URL.createObjectURL(blob);
        self.picUrls = next;
      }).catch(function () {
        var next = Object.assign({}, self.picUrls);
        next[key] = '';
        self.picUrls = next;
      }).finally(function () { delete groupPicLoading[key]; });
      return '';
    },
    // As in the chat: Enter sends with a keyboard; on a phone it starts a new line and the button sends.
    groupKeydown(event) {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      if (!matchMedia('(pointer: fine)').matches) return;
      event.preventDefault();
      this.sayInGroup();
    },
    async stopGroup() {
      try { await this.api(this.groupPath('group/stop'), { method: 'POST', body: {} }); } catch (error) { if (!error.moved) this.group.error = error.message; }
      this.group.waiting = [];
    },
    // Tapping a member's avatar under the box calls it: @ and its name go into what she is writing.
    callInGroup(id) {
      var who = this.groupMember(id);
      var draft = this.group.draft;
      this.group.draft = (draft && !/\s$/.test(draft) ? draft + ' ' : draft) + '@' + who.name + ' ';
      if (this.$refs && this.$refs.groupInput) this.$refs.groupInput.focus();
    },
    groupMember(id) {
      return this.residents.list.find(function (r) { return r.id === id; }) || { id: id, name: id, avatar: null };
    },
    groupMembers() {
      var self = this;
      return this.group.members.map(function (id) { return self.groupMember(id); });
    },
    groupStatus() {
      var group = this.group;
      if (group.speaking) return this.groupMember(group.speaking).name + ' 正在想…';
      return group.members.length + ' 个住户和你';
    },
    newGroup() {
      this.residents.open = false;
      var on = {};
      this.residents.list.forEach(function (r) { on[r.id] = true; });
      this.groupEdit = { id: '', name: '', on: on, reply: 'all', order: 'list', rounds: 3, icon: null, busy: false, error: '' };
    },
    openGroupSettings() {
      var config = this.group.config || { name: this.group.name, members: this.group.members, reply: 'all', order: 'list', rounds: 3, icon: null };
      var on = {};
      this.residents.list.forEach(function (r) { on[r.id] = config.members.indexOf(r.id) >= 0; });
      this.groupEdit = { id: this.group.id, name: config.name, on: on, reply: config.reply, order: config.order, rounds: config.rounds || 3, icon: config.icon || null, busy: false, error: '' };
    },
    // The icon: a square from the picture she picks, made 512 pixels, like the avatar.
    async pickGroupIcon(event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = '';
      var edit = this.groupEdit;
      if (!file || !edit || edit.busy) return;
      edit.busy = true;
      edit.error = '';
      try {
        var blob = await shrinkPicture(file, 512, true);
        this.takeGroups(await this.api('/web/group/icon?g=' + encodeURIComponent(edit.id), { method: 'POST', raw: blob, type: blob.type }), edit);
      } catch (error) {
        if (!error.moved) edit.error = error.message;
      } finally {
        edit.busy = false;
      }
    },
    async removeGroupIcon() {
      var edit = this.groupEdit;
      try { this.takeGroups(await this.api('/web/group/icon/remove?g=' + encodeURIComponent(edit.id), { method: 'POST', body: {} }), edit); } catch (error) { if (!error.moved) edit.error = error.message; }
    },
    // The list with a group's new icon: the sidebar, the sheet and the open group take it.
    takeGroups(data, edit) {
      this.groups = data.groups || [];
      var now = this.groups.find(function (g) { return g.id === edit.id; });
      edit.icon = now ? now.icon : null;
      if (this.group.config && this.group.id === edit.id) this.group.config = Object.assign({}, this.group.config, { icon: edit.icon });
    },
    async saveGroupEdit() {
      var edit = this.groupEdit;
      var members = this.residents.list.filter(function (r) { return edit.on[r.id]; }).map(function (r) { return r.id; });
      var body = { name: edit.name, members: members, reply: edit.reply, order: edit.order, rounds: Number(edit.rounds) };
      edit.busy = true;
      edit.error = '';
      try {
        if (edit.id) {
          this.takeGroup(await this.api('/web/group/config?g=' + encodeURIComponent(edit.id), { method: 'POST', body: body }));
        } else {
          var made = await this.api('/web/groups', { method: 'POST', body: body });
          this.openGroup(made.group.id);
        }
        this.groupEdit = null;
        this.loadGroups().catch(function () {});
      } catch (error) {
        if (!error.moved) edit.error = error.message;
      } finally {
        edit.busy = false;
      }
    },
    async removeGroup() {
      var edit = this.groupEdit;
      if (!confirm('删掉「' + edit.name + '」？群里的话会删掉，各自私聊里听到的还在。')) return;
      edit.busy = true;
      try {
        var data = await this.api('/web/group/remove?g=' + encodeURIComponent(edit.id), { method: 'POST', body: {} });
        this.groups = data.groups || [];
        this.groupEdit = null;
        this.view = 'chat';
      } catch (error) {
        if (!error.moved) edit.error = error.message;
      } finally {
        edit.busy = false;
      }
    }
  };
}
