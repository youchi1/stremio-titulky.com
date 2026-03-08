const isDev = process.env.NODE_ENV === "development";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = isDev ? LEVELS.debug : LEVELS.info;

function fmt(level, tag, msg) {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase()}] [${tag}] ${msg}`;
}

function makeLogger(tag) {
  return {
    debug: (...args) => currentLevel <= LEVELS.debug && console.log(fmt("debug", tag, args.join(" "))),
    info: (...args) => currentLevel <= LEVELS.info && console.log(fmt("info", tag, args.join(" "))),
    warn: (...args) => currentLevel <= LEVELS.warn && console.warn(fmt("warn", tag, args.join(" "))),
    error: (...args) => currentLevel <= LEVELS.error && console.error(fmt("error", tag, args.join(" "))),
  };
}

module.exports = { makeLogger, isDev };
