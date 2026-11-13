'use strict';

/**
 * 存储抽象层：一 note 一文件。
 * 对外只暴露 get / put / remove / list / stat / usage，业务代码不接触 fs。
 * 将来要换 SQLite，只需替换本文件的实现，server.js 无需改动。
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

function assertId(id) {
  if (typeof id !== 'string' || !config.noteIdPattern.test(id)) {
    const err = new Error('invalid note id');
    err.code = 'INVALID_ID';
    throw err;
  }
}

function filePath(id) {
  assertId(id);
  const dir = path.resolve(config.dataDir);
  const file = path.resolve(dir, id);
  if (path.dirname(file) !== dir) {
    const err = new Error('note id escapes data dir');
    err.code = 'INVALID_ID';
    throw err;
  }
  return file;
}

// 同一个 note 的写操作串行化，避免多标签页 / 多设备并发写互相踩踏
const queues = new Map();

function serialize(id, task) {
  assertId(id);
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  queues.set(id, next);
  const cleanup = () => {
    if (queues.get(id) === next) queues.delete(id);
  };
  next.then(cleanup, cleanup);
  return next;
}

async function ensureDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

async function get(id) {
  const file = filePath(id);
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
    throw err;
  }
}

function put(id, text) {
  assertId(id);
  if (typeof text !== 'string') {
    const err = new Error('text must be a string');
    err.code = 'INVALID_TEXT';
    throw err;
  }

  // 与 index.php:31-33 一致：空内容即删除文件
  if (text.length === 0) return remove(id);

  return serialize(id, async () => {
    await ensureDir();
    const target = filePath(id);
    const tmp = path.join(
      config.dataDir,
      `.${id}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    );
    try {
      const handle = await fs.open(tmp, 'w');
      try {
        await handle.writeFile(text, 'utf8');
        try {
          await handle.sync();
        } catch {
          // 个别平台不支持 fsync，忽略即可
        }
      } finally {
        await handle.close();
      }
      // 同目录 rename 是原子操作：读者看到的永远是旧内容或完整新内容
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  });
}

function remove(id) {
  return serialize(id, async () => {
    try {
      await fs.unlink(filePath(id));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  });
}

async function list() {
  await ensureDir();
  const names = await fs.readdir(config.dataDir);
  return names.filter(
    (name) =>
      config.noteIdPattern.test(name) &&
      !name.startsWith('.') &&
      !config.reservedNames.includes(name)
  );
}

async function stat(id) {
  const file = filePath(id);
  try {
    const info = await fs.stat(file);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// 全局用量统计，供容量水位线判断；过滤掉临时文件与保留名
async function usage() {
  const ids = await list();
  let bytes = 0;
  let files = 0;
  for (const id of ids) {
    try {
      const info = await fs.stat(filePath(id));
      if (!info.isFile()) continue;
      bytes += info.size;
      files += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return { bytes, files };
}

module.exports = { get, put, remove, list, stat, usage };
