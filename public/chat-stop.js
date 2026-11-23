// Chat cancellation is separate from message delivery and machine-thread controls.
function chatStopPage() {
  return {
    chatTurn: null,
    stopReplyBusy: false,
    syncChatTurn(turn) {
      this.chatTurn = turn && typeof turn.requestId === 'string'
        ? { requestId: turn.requestId, stopping: Boolean(turn.stopping) } : null;
    },
    async stopReply() {
      if (!this.chatTurn || this.stopReplyBusy || this.chatTurn.stopping) return;
      var requestId = this.chatTurn.requestId;
      if (this.playing && this.lines.some((line) => line.pending && line.voice?.key === this.playing)) this.stopPlaying();
      this.stopReplyBusy = true;
      try {
        var result = await this.api('/web/stop', { method: 'POST', body: { requestId: requestId } });
        if (this.chatTurn && this.chatTurn.requestId === requestId && result.status === 'stopping') {
          this.chatTurn.stopping = true;
        }
        await this.refresh(true);
      } catch (error) {
        this.notify(error.message);
      } finally {
        this.stopReplyBusy = false;
        this.poll(this.replying());
      }
    }
  };
}
