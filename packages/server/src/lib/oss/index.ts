/**
 * Provider factory. Picks the right implementation based on env config.
 *
 * Currently only `qiniu` is fully implemented. The other branches return
 * null + log a warning so the server boots cleanly with mirror disabled,
 * rather than handing back a throwing stub that only fails at click time.
 */

import { QiniuProvider } from './qiniu.js';
import type { OssEnv, OssProvider } from './types.js';

const NOT_IMPLEMENTED = new Set(['tencent-cos', 'aliyun-oss', 's3']);

export function createOssProvider(env: OssEnv): OssProvider | null {
  if (!env.enabled) return null;
  switch (env.provider) {
    case 'qiniu':
      return new QiniuProvider({
        accessKey: env.accessKey,
        secretKey: env.secretKey,
        bucket: env.bucket,
        region: env.region,
        publicHost: env.publicHost,
        privateBucket: true,
      });
    default:
      if (NOT_IMPLEMENTED.has(env.provider)) {
        console.warn(
          `[oss] provider "${env.provider}" is not implemented yet — mirror disabled. ` +
            `See packages/server/src/lib/oss/stubs.ts to contribute an implementation.`,
        );
      }
      return null;
  }
}

export * from './types.js';
