const readline = require('readline');
const { ConnectionStatus } = require('../state');

class Dashboard {
  constructor(stateManager, config) {
    this.state = stateManager;
    this.config = config;
    this.refreshInterval = null;
    this.lastRender = '';
    this.rl = null;
  }

  start() {
    const refreshRate = this.config.dashboard.refreshRate;
    this.refreshInterval = setInterval(() => this.render(), refreshRate);
    this.render();
  }

  stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  render() {
    const status = this.state.getStatus();
    const lines = [];

    lines.push(this.formatHeader());
    lines.push(this.formatConnection(status));
    lines.push(this.formatPlayer(status));
    lines.push(this.formatSession(status));
    lines.push(this.formatAutomation(status));

    const output = lines.join('\n');

    if (output !== this.lastRender) {
      this.lastRender = output;
      this.clearAndWrite(output);
    }
  }

  formatHeader() {
    const version = this.config.server.version || 'unknown';
    return ` Bedrock Companion v1.0.0 (BDS ${version}) `.padEnd(50, '─');
  }

  formatConnection(status) {
    const icons = {
      [ConnectionStatus.CONNECTED]: '●',
      [ConnectionStatus.CONNECTING]: '◐',
      [ConnectionStatus.RECONNECTING]: '◑',
      [ConnectionStatus.DISCONNECTED]: '○',
      [ConnectionStatus.FAILED]: '✕',
    };

    const statusText = status.status.toUpperCase().padEnd(15);
    const icon = icons[status.status] || '?';
    let line = `│ ${icon} Status: ${statusText} │`;

    if (status.reconnect.lastDisconnectReason) {
      line += `\n│   Disconnect: ${status.reconnect.lastDisconnectReason}`;
    }

    return line;
  }

  formatPlayer(status) {
    const p = status.player;
    const hasPlayer = p.username !== null;

    if (!hasPlayer) {
      return `│ ─ Player: Not logged in ──────────────────────── │`;
    }

    const health = `♥${p.health}`;
    const hunger = `♡${p.hunger}`;
    const pos = `x:${Math.round(p.position.x)} y:${Math.round(p.position.y)} z:${Math.round(p.position.z)}`;
    const dim = p.dimension || 'overworld';

    return `│ Player: ${p.username.padEnd(15)} ${health} ${hunger.padEnd(5)} │\n│ Position: ${pos.slice(0, 28).padEnd(28)} │\n│ Dimension: ${dim.padEnd(35)} │`;
  }

  formatSession(status) {
    const s = status.session;
    const lines = [];

    if (s.serverAddress) {
      lines.push(`│ Server: ${s.serverAddress}:${s.serverPort}`);
    }

    if (this.config.dashboard.showLatency && s.latency !== null) {
      lines.push(`│ Latency: ${s.latency}ms`);
    }

    if (status.reconnect.retryCount > 0) {
      lines.push(`│ Retries: ${status.reconnect.retryCount}/${this.config.reconnect.maxRetries}`);
    }

    if (lines.length === 0) {
      return `│ Session: Idle`;
    }

    return lines.join(' '.padEnd(40));
  }

  formatAutomation(status) {
    if (!this.config.dashboard.showAutomation) {
      return '';
    }

    const auto = status.automation;
    const enabled = this.config.automation.enabled;
    const statusText = enabled ? (auto.active ? 'Active' : 'Idle') : 'Disabled';

    return `│ Automation: ${statusText.padEnd(35)} │`;
  }

  clearAndWrite(output) {
    const lines = output.split('\n').length;
    process.stdout.write('\x1b[' + lines + 'A\x1b[2K\x1b[0G' + output + '\n');
  }
}

module.exports = { Dashboard };