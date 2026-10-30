// Group chats (src/group.ts): she makes groups of some of her residents and talks with them there. app.js mixes this
// into the page's state. The groups live in the first resident, so they are the same from whichever resident's page.
function groupPage() {
  var GROUP_MS = 3000;
  var groupTimer = 0;
  function freshGroup(id) {
    return { id: id || '', name: '', loaded: false, lines: [], more: false, members: [], config: null, speaking: '', waiting: [], running: false, draft: '', busy: false, error: '' };
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
        group.lines = older ? data.lines.concat(group.lines) : data.lines;
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
        var group = self.group;
        if (!document.hidden) {
          var last = group.lines[group.lines.length - 1];
          try {
            var data = await self.api(self.groupPath('group', '&after=' + (last ? last.seq : 0)));
            if (self.view !== 'group' || group !== self.group) return;
            var seen = {};
            group.lines.forEach(function (line) { seen[line.seq] = true; });
            var fresh = (data.lines || []).filter(function (line) { return !seen[line.seq]; });
            group.lines = group.lines.concat(fresh);
            self.takeGroup(data);
            if (fresh.length) self.groupToEnd();
          } catch (error) { /* tried again on the next tick */ }
        }
        self.pollGroup();
      }, GROUP_MS);
    },
    groupToEnd() {
      var self = this;
      this.$nextTick(function () { var el = self.$refs && self.$refs.groupStream; if (el) el.scrollTop = el.scrollHeight; });
    },
    async sayInGroup() {
      var group = this.group;
      var text = group.draft.trim();
      if (!text || group.busy) return;
      group.busy = true;
      group.error = '';
      try {
        var data = await this.api(this.groupPath('group/say'), { method: 'POST', body: { text: text } });
        group.draft = '';
        if (!group.lines.some(function (line) { return line.seq === data.line.seq; })) group.lines.push(data.line);
        group.running = true;
        this.groupToEnd();
      } catch (error) {
        if (!error.moved) group.error = error.message;
      } finally {
        group.busy = false;
      }
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
      this.groupEdit = { id: '', name: '', on: on, reply: 'all', order: 'list', busy: false, error: '' };
    },
    openGroupSettings() {
      var config = this.group.config || { name: this.group.name, members: this.group.members, reply: 'all', order: 'list' };
      var on = {};
      this.residents.list.forEach(function (r) { on[r.id] = config.members.indexOf(r.id) >= 0; });
      this.groupEdit = { id: this.group.id, name: config.name, on: on, reply: config.reply, order: config.order, busy: false, error: '' };
    },
    async saveGroupEdit() {
      var edit = this.groupEdit;
      var members = this.residents.list.filter(function (r) { return edit.on[r.id]; }).map(function (r) { return r.id; });
      var body = { name: edit.name, members: members, reply: edit.reply, order: edit.order };
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
