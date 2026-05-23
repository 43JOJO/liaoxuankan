/**
 * lib/checkpoint.js — 统一断点续传
 *
 * 解决 P1：此前断点续传各脚本各写一套、且半数脚本没有。统一为：
 *   loadCheckpoint(name)        读取（不存在则返回默认结构）
 *   saveCheckpoint(name, id)    把 id 加入 done 集合并落盘
 *   saveCheckpoint(name, patch) 传对象则合并状态（如 {lastIndex}）
 *   openCheckpoint(name)        返回带内存缓存的句柄，避免每条都读文件
 *
 * checkpoint 用 atomicWrite（不走 safeWrite 的备份逻辑），避免每条都生成 .bak。
 */
const fs = require('fs');
const config = require('./config');
const { atomicWrite, ensureDir } = require('./backup');

function pathFor(name) {
  return config.checkpointPath(name);
}

function loadCheckpoint(name) {
  try {
    const obj = JSON.parse(fs.readFileSync(pathFor(name), 'utf-8'));
    if (!Array.isArray(obj.done)) obj.done = [];
    return obj;
  } catch (_) {
    return { name: String(name), done: [], lastIndex: -1, updatedAt: null };
  }
}

function writeRaw(name, state) {
  state.updatedAt = new Date().toISOString();
  ensureDir(config.paths.checkpoints);
  atomicWrite(pathFor(name), JSON.stringify(state, null, 2));
  return state;
}

function saveCheckpoint(name, idOrPatch) {
  const state = loadCheckpoint(name);
  if (idOrPatch && typeof idOrPatch === 'object') {
    const { done, ...rest } = idOrPatch;
    Object.assign(state, rest);
    if (Array.isArray(done)) state.done = [...new Set([...state.done, ...done.map(String)])];
  } else if (idOrPatch != null) {
    const id = String(idOrPatch);
    if (!state.done.includes(id)) state.done.push(id);
  }
  return writeRaw(name, state);
}

function isDone(name, id) {
  return loadCheckpoint(name).done.includes(String(id));
}

function resetCheckpoint(name) {
  try { fs.unlinkSync(pathFor(name)); } catch (_) {}
}

// 有状态句柄：长任务里用它，省去每条 read+parse
function openCheckpoint(name) {
  const state = loadCheckpoint(name);
  const set = new Set(state.done.map(String));
  return {
    state,
    has(id) { return set.has(String(id)); },
    add(id) {
      const s = String(id);
      if (!set.has(s)) { set.add(s); state.done.push(s); }
      return this;
    },
    set(patch) { Object.assign(state, patch); return this; },
    save() { return writeRaw(name, state); },
    get size() { return set.size; },
  };
}

module.exports = { loadCheckpoint, saveCheckpoint, isDone, resetCheckpoint, openCheckpoint };
