/**
 * Stubs for Tencent COS and Aliyun OSS providers.
 *
 * These ship as placeholders so the abstraction stays meaningful — switching
 * providers is just an env change away once filled in. The actual API
 * signing for COS / OSS is meaningfully more complex than Qiniu's (multi-
 * line canonical request, URL-encoding rules etc.) so we delay full impl
 * until there's a concrete need.
 *
 * To finish them later:
 *   - Tencent COS: PutObjectFromUrl async fetch
 *       https://cloud.tencent.com/document/product/436/76710
 *     Signing: COS XML API v5 — https://cloud.tencent.com/document/product/436/7778
 *   - Aliyun OSS: PostObject + fetch (async import) on some bundle plans
 *     Signing: https://help.aliyun.com/zh/oss/developer-reference/include-signatures-in-the-authorization-header
 */

import type {
  CloudFetchOptions,
  CloudFetchResult,
  ObjectInfo,
  OssProvider,
} from './types.js';

class NotImplementedProvider implements OssProvider {
  constructor(public readonly name: string) {}

  cloudFetch(_opts: CloudFetchOptions): Promise<CloudFetchResult> {
    return Promise.reject(new Error(`${this.name} provider not implemented yet`));
  }

  head(_objectKey: string): Promise<ObjectInfo> {
    return Promise.resolve({ exists: false });
  }

  signGetUrl(_objectKey: string): string {
    throw new Error(`${this.name} provider not implemented yet`);
  }
}

export class TencentCosProvider extends NotImplementedProvider {
  constructor() {
    super('tencent-cos');
  }
}

export class AliyunOssProvider extends NotImplementedProvider {
  constructor() {
    super('aliyun-oss');
  }
}

export class S3CompatProvider extends NotImplementedProvider {
  constructor() {
    super('s3');
  }
}
