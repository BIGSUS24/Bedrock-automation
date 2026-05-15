const readline = require('readline');

class MessageBar {
  constructor(stateManager, config, sendCallback) {
    this.state = stateManager;
    this.config = config;
    this.sendCallback = sendCallback;
    this.history = [];
    this.historyIndex = -1;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  start() {
    this.prompt();
    this.rl.on('line', (input) => this.handleInput(input));
  }

  stop() {
    this.rl.close();
  }

  prompt() {
    const prompt = this.config.ui.prompt || '> ';
    process.stdout.write(prompt);
  }

  handleInput(input) {
    const trimmed = input.trim();

    if (!trimmed) {
      this.prompt();
      return;
    }

    this.addToHistory(trimmed);

    if (trimmed.startsWith('/')) {
      const command = trimmed.slice(1);
      this.sendCommand(command);
      this.logSent(`[CMD] /${command}`);
    } else {
      this.sendChat(trimmed);
      this.logSent(`[CHAT] ${trimmed}`);
    }

    this.state.recordChat();
    this.prompt();
  }

  async sendChat(message) {
    try {
      await this.sendCallback('chat', message);
    } catch (error) {
      console.error(`Failed to send chat: ${error.message}`);
    }
  }

  async sendCommand(command) {
    try {
      await this.sendCallback('command', command);
    } catch (error) {
      console.error(`Failed to send command: ${error.message}`);
    }
  }

  addToHistory(input) {
    const history = this.history;
    if (history[history.length - 1] !== input) {
      history.push(input);
      if (history.length > this.config.ui.historySize) {
        history.shift();
      }
    }
    this.historyIndex = this.history.length;
  }

  getHistoryNav(direction) {
    if (this.history.length === 0) {
      return '';
    }

    if (direction === 'up') {
      this.historyIndex = Math.max(0, this.historyIndex - 1);
    } else if (direction === 'down') {
      this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
    }

    if (this.historyIndex >= this.history.length) {
      return '';
    }

    return this.history[this.historyIndex];
  }

  logSent(message) {
    const time = new Date().toLocaleTimeString();
    console.log(`  §7${time}§r ${message}`);
  }

  logReceived(message, sender) {
    const time = new Date().toLocaleTimeString();
    const from = sender || 'Server';
    console.log(`  §b${time}§r <${from}> ${message}`);
  }

  logSystem(message) {
    const time = new Date().toLocaleTimeString();
    console.log(`  §e${time}§r §o[SYS]§r ${message}`);
  }
}

module.exports = { MessageBar };