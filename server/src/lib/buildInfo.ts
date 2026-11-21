/**
 * 构建信息：回答「线上跑的到底是哪一版」。
 *
 * 由 deploy/deploy-nas.sh 在打包后写入 server/dist/build-info.json
 * （git 短哈希 + 打包时间 + 是否有未提交改动），随产物一起进镜像。
 * 本地 tsx 直跑时读不到该文件，退化成 dev，属正常。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_ROOT } from './paths.js';

interface BuildInfo {
  /** git 短哈希，未纳入版本控制时为 nogit */
  commit: string;
  /** 打包时间 */
  builtAt: string;
  /** 打包时工作区是否有未提交改动 */
  dirty: boolean;
}

const INFO_FILE = join(SERVER_ROOT, 'dist', 'build-info.json');

function readBuildInfo(): BuildInfo {
  if (!existsSync(INFO_FILE)) {
    return { commit: 'dev', builtAt: 'unknown', dirty: false };
  }
  try {
    const raw = JSON.parse(readFileSync(INFO_FILE, 'utf8')) as Partial<BuildInfo>;
    return {
      commit: typeof raw.commit === 'string' ? raw.commit : 'unknown',
      builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : 'unknown',
      dirty: raw.dirty === true,
    };
  } catch (error) {
    console.error('[build-info] 解析 build-info.json 失败，按 dev 处理', error);
    return { commit: 'dev', builtAt: 'unknown', dirty: false };
  }
}

export const BUILD_INFO = readBuildInfo();

/** 供日志与接口展示的一行摘要 */
export function buildLabel(): string {
  const { commit, builtAt, dirty } = BUILD_INFO;
  if (commit === 'dev') return 'dev（本地源码运行）';
  return `${commit}${dirty ? '+dirty' : ''} @ ${builtAt}`;
}
