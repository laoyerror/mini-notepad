'use strict';

/**
 * 可选：把旧 _tmp 目录的笔记复制到 new/data。
 * 源目录全程只读，绝不改写或删除原文件；目标已存在则跳过，不覆盖。
 * 运行：npm run import
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const config = require('../config');

async function main() {
  let names;
  try {
    names = await fs.readdir(config.legacyDataDir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`未找到旧数据目录：${config.legacyDataDir}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  await fs.mkdir(config.dataDir, { recursive: true });

  let copied = 0;
  let skipped = 0;

  for (const name of names) {
    if (
      !config.noteIdPattern.test(name) ||
      name.startsWith('.') ||
      config.reservedNames.includes(name)
    ) {
      skipped++;
      continue;
    }

    const from = path.join(config.legacyDataDir, name);
    const to = path.join(config.dataDir, name);

    try {
      const info = await fs.stat(from);
      if (!info.isFile()) {
        skipped++;
        continue;
      }
    } catch {
      skipped++;
      continue;
    }

    try {
      await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      copied++;
    } catch (err) {
      if (err.code === 'EEXIST') skipped++;
      else throw err;
    }
  }

  console.log(`导入完成：新增 ${copied} 篇，跳过 ${skipped} 项`);
  console.log(`源（只读）：${config.legacyDataDir}`);
  console.log(`目标：${config.dataDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
