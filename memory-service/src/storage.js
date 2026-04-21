// ============================================================
// 模块：记忆文件存储层（Markdown + YAML frontmatter 读写）
// 职责：底层文件 I/O + 路径约定；只懂"把对象存成 md、把 md 读成对象"
// 上层（bucket_manager / indexer）负责元数据校验、业务逻辑、索引
//
// 目录约定：{memoriesDir}/{typeDir}/{primaryDomain}/{filename}.md
//   typeDir:       permanent | dynamic | archived | feel（受 config.paths.subdirs 影响）
//   primaryDomain: domain[0] 或 "未分类"；feel 类型固定 "沉淀物"
//   filename:      {sanitizedName}_{bucketId}.md，或仅 {bucketId}.md
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';

// feel 桶固定子目录名（语义上"情感沉淀物"，不随 domain 变化）
const FEEL_SUBDIR = '沉淀物';
const DEFAULT_DOMAIN = '未分类';

// ========== ID 生成 ==========
// 12 位 hex，对齐参考项目 utils.py:generate_bucket_id（uuid.uuid4().hex[:12]）
export function generateBucketId() {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

// ========== 名称/路径安全 ==========

// Windows + Linux 通用不安全字符，防止文件名注入和路径穿越
const UNSAFE_FILENAME_RE = /[<>:"/\\|?*\x00-\x1f]/g;

// 清洗名称为合法文件名/目录名片段；无效时返回 fallback
export function sanitizeName(name, fallback = DEFAULT_DOMAIN) {
  if (!name || typeof name !== 'string') return fallback;
  const cleaned = name.trim().replace(UNSAFE_FILENAME_RE, '_').replace(/\.+$/, '');
  return cleaned || fallback;
}

// 确保 child 解析后落在 parent 内，阻止 ../../ 越界
export function safePath(parent, child) {
  const absParent = path.resolve(parent);
  const absChild = path.resolve(parent, child);
  if (absChild !== absParent && !absChild.startsWith(absParent + path.sep)) {
    throw new Error(`[storage] 路径越界: ${child} 解析后不在 ${parent} 内`);
  }
  return absChild;
}

// ========== 目录/文件名约定 ==========

// 桶类型 → 存储子目录名（从 config.paths.subdirs 读取，permanent 固定）
// type 取值：permanent | dynamic | archive | feel
export function typeDirFor(baseDir, type, subdirs) {
  const map = {
    permanent: 'permanent',
    dynamic: subdirs.dynamic,
    archive: subdirs.archived,
    feel: subdirs.feel,
  };
  const dirName = map[type] || subdirs.dynamic;
  return path.join(baseDir, dirName);
}

// 从 domain 数组推导主题子目录；feel 类型强制归入"沉淀物"
export function primaryDomain(domain, bucketType) {
  if (bucketType === 'feel') return FEEL_SUBDIR;
  if (!Array.isArray(domain) || !domain.length) return DEFAULT_DOMAIN;
  return sanitizeName(domain[0]);
}

// 文件名：有可读名则 {name}_{id}.md，否则 {id}.md（Obsidian 友好）
export function bucketFilename(name, bucketId) {
  const safeName = sanitizeName(name, '');
  return safeName && safeName !== bucketId ? `${safeName}_${bucketId}.md` : `${bucketId}.md`;
}

// 组合出桶的完整目标路径（含 safePath 越界校验）
export function bucketFilePath(baseDir, type, domain, name, bucketId, subdirs) {
  const typeDir = typeDirFor(baseDir, type, subdirs);
  const domainDir = path.join(typeDir, primaryDomain(domain, type));
  return safePath(domainDir, bucketFilename(name, bucketId));
}

// ========== 读写 ==========

// 读 md 文件 → { metadata, content, path }；文件不存在或 frontmatter 损坏时返回 null
export async function readBucketFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const { data, content } = matter(raw);
    return { metadata: data || {}, content: content || '', path: filePath };
  } catch (e) {
    console.warn(`[storage] frontmatter 解析失败 ${filePath}: ${e.message}`);
    return null;
  }
}

// 原子写入：先写 .tmp 再 rename，避免进程中断导致半截文件
// Windows 注意：rename 覆盖被占用文件（如 Obsidian 正在读）会抛 EPERM，先 unlink 更稳
export async function writeBucketFile(filePath, metadata, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const serialized = matter.stringify(content || '', metadata || {});
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, serialized, 'utf-8');
    await fs.unlink(filePath).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await fs.rename(tmp, filePath);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

// 删除文件；不存在时返回 false，不抛错
export async function deleteBucketFile(filePath) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

// 移动/重命名文件（跨目录 OK，同路径无操作）
export async function moveBucketFile(srcPath, destPath) {
  if (path.resolve(srcPath) === path.resolve(destPath)) return destPath;
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.rename(srcPath, destPath);
  return destPath;
}

// ========== 扫描/查找 ==========

// 递归收集目录下所有 .md 文件的绝对路径；目录不存在返回空数组
export async function listMdFiles(rootDir) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && ent.name.endsWith('.md')) out.push(full);
    }
  }
  await walk(rootDir);
  return out;
}

// 在指定目录集合中通过 bucketId 查找文件（文件名后缀匹配）
// 注意：线性扫描，频繁调用请走 indexer 缓存
export async function findBucketFileById(bucketId, searchDirs) {
  if (!bucketId || typeof bucketId !== 'string') return null;
  for (const dir of searchDirs) {
    const files = await listMdFiles(dir);
    const hit = files.find(f => {
      const base = path.basename(f, '.md');
      return base === bucketId || base.endsWith(`_${bucketId}`);
    });
    if (hit) return hit;
  }
  return null;
}

// 递归创建目录
export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}
