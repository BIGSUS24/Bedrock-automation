# Diagnosis Report

I ran the tests and executed `diagnose.js` and `src/main.js` to validate the bot's behavior. 

Here is what went wrong and why the bot crashes with an unhandled `'error'` event during reconnect attempts.

### 1. The Crash: Unhandled `'error'` Event
When you run `node src/main.js` without a server running (e.g., trying to connect to `127.0.0.1` as per `config.example.js`), it behaves like this:
1. **Attempt 1:** The `Ping timed out` error occurs. The promise rejects properly.
2. **Attempt 2:** The bot attempts to reconnect. This time it skips the ping (`skipPing: true`) and gets a `Connect timed out` error.
3. **Crash:** The second error causes the Node.js process to crash completely with an `Unhandled 'error' event`.

### 2. The Root Cause: `removeAllListeners()`
In `src/protocol/client.js`, you correctly tried to prevent unhandled error crashes by adding a dummy listener in the constructor:
```javascript
// Prevent unhandled error crashes — our _wireEvents adds specific handlers
this.on('error', () => {});
```

However, when the first connection fails, the `ReconnectStateMachine` triggers a teardown process via `CleanupManager` in `src/reconnect/cleanup.js`. 

In `src/reconnect/cleanup.js`, line 86, the cleanup manager does this:
```javascript
_removeListeners() {
  if (this.protocol && typeof this.protocol.removeAllListeners === 'function') {
    this.protocol.removeAllListeners();
  }
}
```

This strips **all** listeners from the `BedrockProtocolClient` instance, including the dummy `'error'` listener you set up in the constructor! 

### 3. The Sequence of Failure
1. Connection 1 fails (`Ping timed out`).
2. `ReconnectStateMachine` calls `CleanupManager.perform()`.
3. `CleanupManager` calls `this.protocol.removeAllListeners()`, wiping out `this.on('error', () => {})`.
4. Reconnection Attempt 1 starts.
5. `_wireEvents()` attaches the internal error handler:
   ```javascript
   c.on('error', (err) => {
     // ...
     this.emit('error', e); // <-- This crashes the process
   });
   ```
6. When Attempt 1 fails (`Connect timed out`), `this.emit('error', e)` is fired. Since `cleanup.js` removed the dummy listener and nothing else is listening to `'error'` on `this.protocol`, Node.js throws the unhandled error and terminates the bot.

### How you can fix it (No changes made, as requested)
To fix this, you should avoid calling `this.protocol.removeAllListeners()` without restoring the dummy error listener. Alternatively, instead of removing all listeners blindly in `cleanup.js`, you could have `BedrockProtocolClient` manage its own listener cleanup, ensuring it never unregisters the internal crash-prevention listener.
