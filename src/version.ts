/**
 * 版本真值(纯函数 + 构建期内联常量,host/client 共用,可单元测试)。
 *
 * 问题背景(实测):面板徽标来自 client bundle,而 `lib/client.js` 是**每次刷新页面**
 * 从磁盘重新取的,`lib/index.js` 却在宿主进程启动时就固定了。于是"改了代码 → 构建 →
 * 刷新页面"这条路上,界面是新的、后台还是旧的,徽标显示 v0.3.0 而实际执行 v0.2.0 的
 * 辩论逻辑——版本号在说谎,而 DSH 没有插件热重载(`dsh plugin` 只是 pnpm 包装)。
 *
 * 解法分两层:
 * 1. `BUILD_VERSION` 由**构建期**从 package.json 内联进两个 bundle,所以每个运行时
 *    报出的都是"我自己这份代码被构建时的版本",而不是磁盘上现在的版本。
 * 2. `assessVersions` 拿三份事实对账:本进程实际版本 / 磁盘待生效版本 / bundle mtime
 *    与进程启动时间的先后。由此显示的版本号永远等于**真正在跑的那个版本**,
 *    并在磁盘更新时明确要求重启宿主。
 */
import pkg from '../package.json'

/**
 * 构建期内联的版本号 = 构建这份 bundle 时 package.json 的 `version`。
 * host 与 client 各内联一份:前者代表"本进程加载的辩论逻辑版本",
 * 后者代表"浏览器加载的界面版本"。两者都可能落后于磁盘。
 */
export const BUILD_VERSION: string = pkg.version

/** 版本对账输入(由 host 收集:内联常量 + 磁盘探针 + 进程启动时刻)。 */
export interface VersionFacts {
  /** 本进程内联的版本(实际在跑的 host 代码)。 */
  running: string
  /** 磁盘上 `dsh.plugin.json` 的版本(重启后会生效的版本);读不到为 null。 */
  disk: string | null
  /** `lib/index.js` 的 mtime;读不到为 null(如 vitest 下从源码直跑)。 */
  bundleMtimeMs: number | null
  /** 本进程启动时刻(ms)。 */
  startedAtMs: number
}

/** 版本对账结论。 */
export interface VersionVerdict {
  /** true = 磁盘上的代码比本进程新,当前显示的版本不代表最新代码。 */
  stale: boolean
  /** 人话原因;不 stale 时为 null。 */
  reason: string | null
}

/**
 * 判定"在跑的代码是否落后于磁盘代码"。
 *
 * 两条独立证据,取或:
 * - **mtime 晚于进程启动**:那次构建发生在进程启动之后,本进程不可能包含其改动。
 *   即使忘了 bump 版本号也查得出来(这条是版本号之外的安全网)。
 * - **版本号不一致**:磁盘 manifest 与内联版本不同,说明磁盘换过版本。
 *
 * 只看版本号会漏掉"改了代码忘了 bump";只看 mtime 会漏掉"文件被换回旧版本"。
 */
export function assessVersions(f: VersionFacts): VersionVerdict {
  const rebuiltAfterStart = f.bundleMtimeMs !== null && f.bundleMtimeMs > f.startedAtMs
  const versionDiffers = f.disk !== null && f.disk.trim() !== '' && f.disk !== f.running
  if (rebuiltAfterStart && versionDiffers) {
    return {
      stale: true,
      reason: `磁盘代码已是 v${f.disk},本进程仍在跑 v${f.running}:bundle 在启动后被重新构建过,需重启宿主才会生效。`,
    }
  }
  if (rebuiltAfterStart) {
    return {
      stale: true,
      reason: `bundle 在本进程启动后被重新构建过(版本号仍是 v${f.running},可能没 bump),本进程跑的是构建前的代码,需重启宿主。`,
    }
  }
  if (versionDiffers) {
    return {
      stale: true,
      reason: `磁盘代码是 v${f.disk},本进程跑的是 v${f.running},需重启宿主才会生效。`,
    }
  }
  return { stale: false, reason: null }
}

/**
 * 界面 bundle 与后台核心是否一致:不一致说明浏览器缓存了旧界面
 * (刷新页面即可修),与"后台要重启"是两回事,提示不能混。
 */
export function isClientStale(clientVersion: string, runningVersion: string): boolean {
  return clientVersion !== runningVersion
}
