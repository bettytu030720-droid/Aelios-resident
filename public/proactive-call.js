// Resident-initiated incoming web call: ring banner, multi-tab coordination, and handoff into startCall().
function proactiveCallPage() {
  var clientId = 'tab_' + Math.random().toString(36).slice(2, 10);
  var handled = new Set();
  var expiryTimer = 0;
  var channel = null;

  function clearTimer() {
    if (!expiryTimer) return;
    clearTimeout(expiryTimer);
    expiryTimer = 0;
  }

  function setTitle(page, ringing) {
    if (typeof document === 'undefined') return;
    var name = (page.identity && page.identity.name) || '住户';
    document.title = ringing ? '来电 · ' + name : name;
  }

  function ensureChannel(page) {
    if (channel || typeof BroadcastChannel !== 'function') return;
    try {
      channel = new BroadcastChannel('resident-proactive-call');
      channel.onmessage = function (event) {
        var msg = event && event.data;
        if (!msg || msg.type !== 'resolved' || typeof msg.id !== 'string' || typeof msg.residentId !== 'string') return;
        if (dismiss(page, msg.id, msg.residentId) && page.authed) page.refresh(true).catch(function () {});
      };
    } catch (e) {
      channel = null;
    }
  }

  function dismiss(page, id, residentId) {
    handled.add(residentId + '/' + id);
    if (residentId !== page.resident || !page.incomingCall || page.incomingCall.id !== id) return false;
    clearTimer();
    page.incomingCall = null;
    setTitle(page, false);
    return true;
  }

  function resolve(page, id, residentId) {
    dismiss(page, id, residentId);
    if (!channel) return;
    try { channel.postMessage({ type: 'resolved', id: id, residentId: residentId }); } catch (e) {}
  }

  return {
    incomingCall: null,
    incomingCallBusy: false,
    resetIncomingCall() {
      clearTimer();
      this.incomingCall = null;
      this.incomingCallBusy = false;
      setTitle(this, false);
    },
    syncIncomingCall(data) {
      ensureChannel(this);
      var incoming = data && data.incomingCall;
      var now = Date.now();
      var valid = Boolean(
        incoming &&
        typeof incoming.id === 'string' &&
        incoming.id &&
        incoming.residentId === this.resident &&
        !handled.has(incoming.residentId + '/' + incoming.id) &&
        !this.calling &&
        (typeof incoming.expiresAt !== 'number' || incoming.expiresAt > now)
      );
      if (!valid) {
        if (this.incomingCall) {
          clearTimer();
          this.incomingCall = null;
          setTitle(this, false);
        }
        return;
      }
      var isNew = !this.incomingCall || this.incomingCall.id !== incoming.id;
      this.incomingCall = {
        id: incoming.id,
        residentId: incoming.residentId,
        topic: incoming.topic || '',
        createdAt: incoming.createdAt || now,
        expiresAt: incoming.expiresAt || (now + 45000)
      };
      setTitle(this, true);
      clearTimer();
      var self = this;
      var callId = this.incomingCall.id;
      var targetResident = this.resident;
      var waitMs = Math.max(250, this.incomingCall.expiresAt - now + 250);
      expiryTimer = setTimeout(function () {
        expiryTimer = 0;
        if (self.resident !== targetResident || !self.incomingCall || self.incomingCall.id !== callId) return;
        self.incomingCall = null;
        setTitle(self, false);
        if (self.authed) self.refresh(true).catch(function () {});
      }, waitMs);
      if (isNew && this.authed) this.poll(true);
    },
    incomingCallTitle() {
      return ((this.identity && this.identity.name) || '住户') + ' 来电';
    },
    incomingCallSubtitle() {
      return (this.incomingCall && this.incomingCall.topic) || '有事想和你语音聊聊';
    },
    async answerIncomingCall() {
      if (!this.incomingCall || this.incomingCallBusy || this.calling || this.recording) return;
      if (this.incomingCall.residentId !== this.resident) {
        this.resetIncomingCall();
        return;
      }
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.notify('这个浏览器录不了音');
        return;
      }
      var epoch = this.callEpoch();
      var targetResident = this.resident;
      var callId = this.incomingCall.id;
      var known = new Set(this.lines.map(function (line) { return line.id; }));
      var audio = this.prepareCallAudio();
      if (!audio) {
        this.notify('这个浏览器录不了音');
        return;
      }
      this.incomingCallBusy = true;
      try {
        var result = await this.api('/web/call/answer', {
          method: 'POST',
          body: { id: callId, residentId: targetResident, clientId: clientId }
        });
        if (epoch !== this.callEpoch() || this.resident !== targetResident) return;
        if (!result || result.status !== 'answered' || result.id !== callId || result.residentId !== targetResident || !result.messageId) {
          throw new Error('接听结果不完整');
        }
        resolve(this, callId, targetResident);
        this.view = 'chat';
        this.scrollSoon(true);
        var context = audio;
        audio = null;
        await this.startCall({
          context: context,
          initialWait: { messageId: result.messageId, known: known }
        });
        await this.refresh(true).catch(function () {});
      } catch (error) {
        if (error?.moved || epoch !== this.callEpoch() || this.resident !== targetResident) return;
        if (error?.status === 409) {
          resolve(this, callId, targetResident);
          this.notify(error.message);
          await this.refresh(true).catch(function () {});
        } else this.notify('接听失败，请再试一次');
      } finally {
        if (audio) audio.close().catch(function () {});
        if (epoch === this.callEpoch()) this.incomingCallBusy = false;
      }
    },
    async declineIncomingCall() {
      if (!this.incomingCall || this.incomingCallBusy) return;
      if (this.incomingCall.residentId !== this.resident) {
        this.resetIncomingCall();
        return;
      }
      var epoch = this.callEpoch();
      var targetResident = this.resident;
      var callId = this.incomingCall.id;
      this.incomingCallBusy = true;
      try {
        var result = await this.api('/web/call/decline', {
          method: 'POST',
          body: { id: callId, residentId: targetResident, clientId: clientId }
        });
        if (epoch !== this.callEpoch() || this.resident !== targetResident) return;
        if (!result || result.status !== 'declined' || result.id !== callId || result.residentId !== targetResident) {
          throw new Error('拒接结果不完整');
        }
        resolve(this, callId, targetResident);
        await this.refresh(true).catch(function () {});
      } catch (error) {
        if (error?.moved || epoch !== this.callEpoch() || this.resident !== targetResident) return;
        if (error?.status === 409) {
          resolve(this, callId, targetResident);
          this.notify(error.message);
          await this.refresh(true).catch(function () {});
        } else this.notify('拒接失败，请再试一次');
      } finally {
        if (epoch === this.callEpoch()) this.incomingCallBusy = false;
      }
    }
  };
}
