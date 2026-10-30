// The group chat page (src/group.ts): she and the residents she picks, in one room. app.js mixes this into the
// page's state. The room lives in the first resident, so it is the same from whichever resident's page it opens.
function groupPage() {
  var GROUP_MS = 3000;
  var groupTimer = 0;
  function freshGroup() {
    return { loaded: false, lines: [], more: false, members: [], config: null, speaking: '', waiting: [], running: false, draft: '', busy: false, error: '', settings: null };
  }
  return {
    group: freshGroup(),
    // A group needs at least two residents.
    groupOn() {
      return !this.miniApp && this.residents.list.length > 1;
    },
    openGroup() {
      this.residents.open = false;
      this.view = 'group';
      this.group = freshGroup();
      this.loadGroup();
    },
    async loadGroup(older) {
      var group = this.group;
      try {
        var first = group.lines[0];
        var data = await this.api('/web/group' + (older && first ? '?before=' + first.seq : ''));
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
      group.members = data.members || group.members;
      group.config = data.config || group.config;
      group.speaking = data.speaking || '';
      group.waiting = data.waiting || [];
      group.running = Boolean(data.running);
    },
    // New lines every few seconds while the page is open and in sight.
    pollGroup() {
      var self = this;
      clearTimeout(groupTimer);
      groupTimer = setTimeout(async function () {
        if (self.view !== 'group' || !self.authed) return;
        if (!document.hidden) {
          var last = self.group.lines[self.group.lines.length - 1];
          try {
            var data = await self.api('/web/group?after=' + (last ? last.seq : 0));
            if (self.view !== 'group') return;
            var seen = {};
            self.group.lines.forEach(function (line) { seen[line.seq] = true; });
            var fresh = (data.lines || []).filter(function (line) { return !seen[line.seq]; });
            self.group.lines = self.group.lines.concat(fresh);
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
        var data = await this.api('/web/group/say', { method: 'POST', body: { text: text } });
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
      try { await this.api('/web/group/stop', { method: 'POST', body: {} }); } catch (error) { if (!error.moved) this.group.error = error.message; }
      this.group.waiting = [];
      this.group.speaking = '';
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
    openGroupSettings() {
      var config = this.group.config || { members: null, reply: 'all', order: 'list', turns: 6 };
      var on = {};
      this.residents.list.forEach(function (r) { on[r.id] = !config.members || config.members.indexOf(r.id) >= 0; });
      this.group.settings = { on: on, reply: config.reply, order: config.order, turns: config.turns, busy: false, error: '' };
    },
    async saveGroupSettings() {
      var edit = this.group.settings;
      var members = this.residents.list.filter(function (r) { return edit.on[r.id]; }).map(function (r) { return r.id; });
      edit.busy = true;
      edit.error = '';
      try {
        var data = await this.api('/web/group/config', { method: 'POST', body: { members: members, reply: edit.reply, order: edit.order, turns: Number(edit.turns) } });
        this.takeGroup(data);
        this.group.settings = null;
      } catch (error) {
        if (!error.moved) edit.error = error.message;
      } finally {
        edit.busy = false;
      }
    }
  };
}
