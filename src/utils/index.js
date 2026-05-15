const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  constructor(config) {
    this.level = LOG_LEVELS[config.logging?.level || 'info'];
    this.timestamp = config.logging?.timestamp !== false;
  }

  debug(...args) {
    if (this.level <= LOG_LEVELS.debug) {
      this.log('DEBUG', ...args);
    }
  }

  info(...args) {
    if (this.level <= LOG_LEVELS.info) {
      this.log('INFO', ...args);
    }
  }

  warn(...args) {
    if (this.level <= LOG_LEVELS.warn) {
      this.log('WARN', ...args);
    }
  }

  error(...args) {
    if (this.level <= LOG_LEVELS.error) {
      this.log('ERROR', ...args);
    }
  }

  log(level, ...args) {
    const prefix = this.timestamp ? `[${new Date().toISOString()}] [${level}]` : `[${level}]`;
    console.log(prefix, ...args);
  }
}

class VersionProfile {
  constructor(versionString) {
    this.versionString = versionString;
    this.parts = this.parseVersion(versionString);
    this.family = this.getFamily();
  }

  parseVersion(versionString) {
    const parts = versionString.split('.').map(Number);
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
      full: versionString,
    };
  }

  getFamily() {
    return `${this.parts.major}.${this.parts.minor}`;
  }

  isAtLeast(major, minor = 0) {
    if (this.parts.major > major) return true;
    if (this.parts.major === major && this.parts.minor >= minor) return true;
    return false;
  }

  isCompatible(profile) {
    return this.family === profile.family;
  }

  static getSupportedFamilies() {
    return ['1.20', '1.21'];
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function sanitizeInput(input, maxLength = 256) {
  if (typeof input !== 'string') return '';
  return input.slice(0, maxLength).replace(/[\x00-\x1F\x7F]/g, '');
}

function formatPosition(pos) {
  if (!pos) return 'unknown';
  return `${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}`;
}

module.exports = { Logger, VersionProfile, deepMerge, sanitizeInput, formatPosition };