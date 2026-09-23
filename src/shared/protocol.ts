/**
 * 自定义协议常量（Main 注册、Preload 生成 URL，必须共用同一份定义）。
 *
 * 为什么不用 file://：
 * - file:// 会带来较宽的本地文件读取面；
 * - 自定义协议只映射 assets/ 目录，并且拒绝路径穿越，权限收敛得多。
 */

export const ASSET_SCHEME = 'pet-asset';

/** 协议内使用的主机名（固定为 assets，表示只服务 assets 目录）。 */
export const ASSET_HOST = 'assets';

/** 允许通过协议访问的扩展名白名单。 */
export const ASSET_ALLOWED_EXTENSIONS: readonly string[] = [
  '.webm',
  '.mp4',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
  '.svg',
];
