/**
 * 自定义素材协议 `pet-asset://assets/<相对路径>`。
 *
 * 为什么需要它：
 * - 透明窗口里播放本地视频，如果直接用 file://，等于把整个磁盘的读取面暴露给渲染进程；
 * - 这里只映射 assets/ 目录，并做三重校验：协议 host、扩展名白名单、路径穿越检查；
 * - 使用 `net.fetch(pathToFileURL(...))` 由 Chromium 原生读取，支持 Range 请求（视频拖动/循环必需）。
 *
 * 安全：任何越界请求返回 403，而不是静默回落到文件系统。
 */

import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ASSET_ALLOWED_EXTENSIONS, ASSET_HOST, ASSET_SCHEME } from '../shared/protocol';
import type { Logger } from '../shared/logger';
import { describeError } from '../shared/errors';

export interface AssetProtocolOptions {
  readonly assetsPath: string;
  readonly logger: Logger;
}

/** 必须在 app ready 之前调用。 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
        corsEnabled: false,
      },
    },
  ]);
}

/** 在 app ready 之后调用。 */
export function registerAssetProtocolHandler(options: AssetProtocolOptions): void {
  const root = resolve(options.assetsPath);

  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== ASSET_HOST) {
        options.logger.warn('asset protocol: invalid host', { data: { host: url.hostname } });
        return new Response('forbidden host', { status: 403 });
      }

      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const target = resolve(root, normalize(relative));

      // 路径穿越防护：解析后必须仍在 assets/ 内
      if (target !== root && !target.startsWith(root + sep)) {
        options.logger.warn('asset protocol: path traversal rejected', { data: { relative } });
        return new Response('forbidden path', { status: 403 });
      }

      const extension = extname(target).toLowerCase();
      if (!ASSET_ALLOWED_EXTENSIONS.includes(extension)) {
        options.logger.warn('asset protocol: extension not allowed', { data: { relative, extension } });
        return new Response('forbidden extension', { status: 403 });
      }

      /*
       * 交给 Chromium 原生读取本地文件。
       *
       * 注意这里必须给一个**超时兜底**：如果 net.fetch 永远不返回，
       * 媒体元素就会停在 `readyState = 0` 且既不触发 loadeddata 也不触发 error，
       * 表现为桌宠永久没有画面（而且没有任何可观测的错误）。
       * 宁可返回 504 让渲染层走失败/自愈路径，也不要静默挂死。
       */
      const response = await withTimeout(
        net.fetch(pathToFileURL(target).toString(), {
          method: request.method,
          headers: request.headers,
          // @ts-expect-error Electron 的 net.fetch 支持 duplex，但 DOM 类型未声明
          duplex: 'half',
        }),
        8000,
        `素材读取超时: ${relative}`,
      );
      return response;
    } catch (error) {
      options.logger.error('asset protocol: read failed', { error: describeError(error), data: { url: request.url } });
      return new Response('asset not found', { status: 404 });
    }
  });

  options.logger.info('asset protocol registered', { data: { scheme: ASSET_SCHEME, root } });
}

/** 给 Promise 加超时（超时抛错，交由上层返回错误响应）。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 供内部（非渲染进程）使用：把 assets 相对路径转成文件绝对路径。 */
export function resolveAssetPath(assetsPath: string, relativePath: string): string {
  return join(resolve(assetsPath), normalize(relativePath));
}
